/**
 * @file Runtime-Loader für externe ESM-Module in Vue 3 Apps.
 * Lädt ein Manifest (index.json), importiert Bundles (index.js), bindet CSS,
 * registriert Routen, merged i18n-Locales (ohne oder mit Namespace) und ruft optionale install()-Hooks auf.
 */

import type { App } from "vue";
import type { Router, RouteRecordRaw } from "vue-router";
import type { I18n } from "vue-i18n";
import type { Pinia } from "pinia";

/* ========================================================================== */
/* Typen                                                                      */
/* ========================================================================== */

export type ModuleContext = {
    app: App;
    router: Router;
    i18n: I18n;
    pinia: Pinia;
};

export type ModuleBundle = {
    /** Modulname; kann als i18n-Namespaceschlüssel genutzt werden */
    name: string;
    /** Modulversion (z.B. "1.2.3") – nur Information/Logging */
    version: string;
    /** Vollständige Route(n) – Parent/Children erlaubt, inkl. meta (z.B. roles) */
    routes?: RouteRecordRaw[];
    /** Lokalisierungen: { de: {...}, en: {...} } */
    locales?: Record<string, any>;
    /** Optionaler Hook für beliebige App-Registrierungen (Plugins, Components, …) */
    install?: (ctx: ModuleContext) => void;
    /** Optionaler Cleanup-Hook für zukünftiges Unload/Switching */
    onUnload?: () => void;
    /**
     * i18n Namespace-Steuerung:
     *  - undefined  → Strategie aus Optionen (Default: bundle.name)
     *  - '' | null  → in den ROOT mergen (KEIN Namespace)
     *  - 'xyz'      → unter 'xyz' mergen
     */
    i18nNamespace?: string | null;
};

export type RemoteModuleRef = {
    /** "admin" */
    name: string;
    /** "1.2.3" | "dev" */
    version: string;

    /* Variante A: URL-Drop-in (gebautes Bundle unter /public/modules/...) */
    /** Basis-URL, z.B. "/modules/admin/1.2.3/" (darf relativ sein) */
    baseUrl?: string;
    /** Haupteinstieg, z.B. "index.js" (kann auch absolute URL sein) */
    entry?: string;
    /** Optionale Stylesheet-Dateien relativ zu baseUrl, z.B. ["style.css"] */
    styles?: string[];

    /* Variante B: Dev-Quelle (ungebaute Datei, Vite wandelt TS/SFC) */
    /** z. B. "/src/modules/admin/src/public-entry.ts" oder "/@fs/ABS/PFAD/.../public-entry.ts" */
    entryDev?: string;

    /* Variante C: Package-Specifier (per Import-Map oder CDN-Resolver) */
    /** z. B. "@org/module-admin" oder vollständige https-URL */
    spec?: string;

    /** Bevorzugte Quelle (optional; überschreibt Default) */
    prefer?: "dev" | "url" | "spec";
};

export type NamespaceStrategy =
    | "moduleName"
    | ((moduleName: string, bundle: ModuleBundle) => string);

export type DuplicateRouteGuard = "name" | "path" | false;

export type ModuleLoaderOptions = {
    /** URL zum Manifest (Default: "/modules/index.json") */
    manifestUrl?: string;
    /** Eigener fetch (z.B. mit CORS/Credentials) */
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /** i18n-Namespace-Strategie (Default: 'moduleName' → <bundle.name>) */
    i18nNamespaceStrategy?: NamespaceStrategy;
    /**
     * Doppelte Routen abfangen.
     * - "name" (Default): überspringt Route, wenn Name bereits existiert
     * - "path":  überspringt Route, wenn Pfad bereits existiert
     * - false:  keine Prüfung
     */
    guardDuplicateRoutes?: DuplicateRouteGuard;
    /** Callback pro erfolgreich geladenem Modul */
    onModuleLoaded?: (bundle: ModuleBundle, ref: RemoteModuleRef) => void;
    /** Callback bei einem Fehler */
    onModuleError?: (ref: RemoteModuleRef, error: unknown) => void;
    /** Vor dem Import Manifest-Einträge filtern/umformen */
    mapManifest?: (refs: RemoteModuleRef[]) => RemoteModuleRef[];
    /** Optional: Log-Funktion */
    log?: (level: "info" | "warn" | "error", ...args: any[]) => void;

    /** Dev-Einträge bevorzugen (Default: true in Dev, false in Prod) */
    preferDevEntries?: boolean;
    /** Bare Specifier → URL auflösen (falls keine Import-Map genutzt wird) */
    resolveSpecifier?: (spec: string) => string | Promise<string>;
    /** Dev-Einträge auch in Prod erlauben (normalerweise false) */
    allowDevEntryInProd?: boolean;
};

/** Ergebnis des Ladevorgangs */
export type LoadResult = {
    loaded: Array<{ bundle: ModuleBundle; ref: RemoteModuleRef }>;
    errors: Array<{ ref: RemoteModuleRef; error: unknown }>;
};

/* ========================================================================== */
/* Utils                                                                      */
/* ========================================================================== */

function defaultLog(level: "info" | "warn" | "error", ...args: any[]) {
    const fn =
        level === "info"
            ? console.info
            : level === "warn"
            ? console.warn
            : console.error;
    fn("[remote-modules]", ...args);
}

function loadCss(href: string) {
    const el = document.createElement("link");
    el.rel = "stylesheet";
    el.href = href;
    document.head.appendChild(el);
    return el;
}

/**
 * "a.b.c": "X" → { a: { b: { c: "X" } } }
 * erhält Objekte/Arrays und expandiert nur flache String-Keys mit Punkten.
 */
function expandDottedKeys(obj: Record<string, any>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (key.includes(".")) {
            const segments = key.split(".");
            let cur = result;
            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];
                if (i === segments.length - 1) {
                    cur[seg] =
                        value &&
                        typeof value === "object" &&
                        !Array.isArray(value)
                            ? expandDottedKeys(value as Record<string, any>)
                            : value;
                } else {
                    cur[seg] = cur[seg] || {};
                    cur = cur[seg];
                }
            }
        } else if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value)
        ) {
            result[key] = expandDottedKeys(value as Record<string, any>);
        } else {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Locales mergen – wahlweise in den ROOT (ohne Namespace) oder unter einem Namespace.
 * Falls ein Namespace angegeben ist und die JSON bereits { [namespace]: {...} } enthält,
 * wird automatisch "entpackt", sodass Doppel-Nesting vermieden wird.
 */
function mergeLocales(
    i18n: I18n,
    namespace: string | null | undefined,
    locales: Record<string, any>
) {
    for (const [lang, msgs] of Object.entries(locales ?? {})) {
        const raw =
            msgs && typeof msgs === "object"
                ? (msgs as Record<string, any>)
                : {};

        // Wenn wir mit Namespace mergen, erlauben wir "Entpacken", falls die Datei bereits { [ns]: {...} } besitzt.
        let normalized: any = raw;
        if (namespace && typeof namespace === "string") {
            const keys = Object.keys(raw);
            const hasOnlyNsAndMeta =
                Object.prototype.hasOwnProperty.call(raw, namespace) &&
                keys.every((k) => k === namespace || k.startsWith("__"));
            if (hasOnlyNsAndMeta) {
                normalized = raw[namespace];
            }
        }

        const expanded =
            typeof normalized === "object"
                ? expandDottedKeys(normalized as Record<string, any>)
                : normalized;

        if (namespace == null || namespace === "") {
            // ROOT-Merge (ohne Namespace)
            (i18n.global as any).mergeLocaleMessage(lang, expanded);
        } else {
            // Unter Namespace mergen
            (i18n.global as any).mergeLocaleMessage(lang, {
                [namespace]: expanded,
            });
        }
    }
}

function ensureArray<T>(v?: T | T[]): T[] {
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
}

/** flache Suche nach existierendem Pfad in den bereits registrierten Routen */
function routerHasPath(router: Router, path: string): boolean {
    // vue-router 4 hat keine direkte "hasPath" API; wir prüfen über getRoutes()
    return router.getRoutes().some((r) => r.path === path);
}

/** macht aus einer evtl. relativen Base ("/modules/...") eine absolute URL */
function toAbsoluteBase(base?: string) {
    if (!base) return base;
    try {
        // bereits absolute URL?
        return new URL(base).toString();
    } catch {
        // relativ → an die aktuelle Origin hängen
        return new URL(base, window.location.origin).toString();
    }
}

/* ========================================================================== */
/* Core                                                                       */
/* ========================================================================== */

/**
 * Lädt ein Manifest, importiert Bundles und registriert alles im Host.
 *
 * @example
 * await loadRemoteModules({ app, router, i18n, pinia }, { manifestUrl: '/modules/index.json' })
 */
export async function loadRemoteModules(
    ctx: ModuleContext,
    options: ModuleLoaderOptions = {}
): Promise<LoadResult> {
    const { app, router, i18n, pinia } = ctx;

    const fetchImpl = options.fetch ?? fetch.bind(window);
    const manifestUrl = options.manifestUrl ?? "/modules/index.json";
    const nsStrategy: NamespaceStrategy =
        options.i18nNamespaceStrategy ?? "moduleName";
    const guard: DuplicateRouteGuard = options.guardDuplicateRoutes ?? "name";
    const log = options.log ?? defaultLog;

    const isProd =
        typeof import.meta !== "undefined" && (import.meta as any).env?.PROD;
    const preferDev = options.preferDevEntries ?? !isProd;

    const result: LoadResult = { loaded: [], errors: [] };

    let refs: RemoteModuleRef[] = [];
    try {
        const res = await fetchImpl(manifestUrl, { cache: "no-cache" });
        if (!res.ok) {
            log(
                "warn",
                `Manifest nicht erreichbar (${manifestUrl}):`,
                res.status
            );
            return result;
        }
        refs = await res.json();
    } catch (e) {
        log("error", "Manifest-Fehler:", e);
        return result;
    }

    if (typeof options.mapManifest === "function") {
        refs = options.mapManifest(refs);
    }

    for (const ref of refs) {
        try {
            // 1) Styles laden (nur sinnvoll bei URL-Drop-ins)
            if (ref.baseUrl && ref.styles?.length) {
                const absBase = toAbsoluteBase(ref.baseUrl)!;
                for (const s of ensureArray(ref.styles)) {
                    loadCss(new URL(s, absBase).toString());
                }
            }

            // 2) Entry auflösen (Dev → URL → Spec)
            const entryInfo = await resolveEntry(ref, {
                preferDev,
                allowDev: options.allowDevEntryInProd,
                resolveSpecifier: options.resolveSpecifier,
            });
            if (!entryInfo) {
                log(
                    "warn",
                    `Kein gültiger Entry für Modul ${ref.name}. Erwartet entryDev (Dev) ODER baseUrl+entry (URL) ODER spec.`
                );
                continue;
            }

            // 3) ESM importieren
            const mod = (await import(/* @vite-ignore */ entryInfo.source)) as {
                default?: ModuleBundle;
            };
            const bundle = mod?.default;
            if (!bundle || !bundle.name) {
                throw new Error(
                    "Ungültiges Bundle: default export fehlt oder name leer"
                );
            }

            // 4) i18n mergen
            // Namespace-Bestimmung: Bundle-Vorgabe > Options-Strategie
            const resolvedNamespace =
                bundle.i18nNamespace !== undefined
                    ? bundle.i18nNamespace
                    : nsStrategy === "moduleName"
                    ? bundle.name
                    : (nsStrategy as Function)(bundle.name, bundle);

            if (bundle.locales) {
                mergeLocales(i18n, resolvedNamespace, bundle.locales);
            }

            // 5) Routen registrieren
            if (Array.isArray(bundle.routes)) {
                for (const route of bundle.routes) {
                    // Duplikate optional abfangen
                    if (guard === "name") {
                        const hasName = !!route.name;
                        if (hasName && router.hasRoute(route.name as string)) {
                            log(
                                "warn",
                                `Route-Name bereits vorhanden → skip: ${String(
                                    route.name
                                )}`
                            );
                            continue;
                        }
                        // Fallback: Wenn kein Name vergeben, prüfe auf Pfad-Duplikat
                        if (
                            !hasName &&
                            route.path &&
                            routerHasPath(router, route.path)
                        ) {
                            log(
                                "warn",
                                `Route-Pfad (Fallback) vorhanden → skip: ${route.path}`
                            );
                            continue;
                        }
                    } else if (guard === "path") {
                        if (route.path && routerHasPath(router, route.path)) {
                            log(
                                "warn",
                                `Route-Pfad vorhanden → skip: ${route.path}`
                            );
                            continue;
                        }
                    }
                    router.addRoute(route);
                }
            }

            // 6) Install-Hook
            bundle.install?.({ app, router, i18n, pinia });

            result.loaded.push({ bundle, ref });
            options.onModuleLoaded?.(bundle, ref);
            log("info", `loaded ${bundle.name}@${bundle.version}`);
        } catch (e) {
            result.errors.push({ ref, error: e });
            options.onModuleError?.(ref, e);
            log(
                "error",
                `Fehler beim Laden von ${ref.name}@${ref.version}:`,
                e
            );
        }
    }

    return result;
}

/* ========================================================================== */
/* Entry-Resolver                                                             */
/* ========================================================================== */

async function resolveEntry(
    ref: RemoteModuleRef,
    opts: {
        preferDev: boolean;
        allowDev?: boolean;
        resolveSpecifier?: (s: string) => string | Promise<string>;
    }
): Promise<{ kind: "dev" | "url" | "spec"; source: string } | null> {
    // 1) Dev bevorzugen?
    const wantsDev = opts.preferDev && !!ref.entryDev;
    const canDev = wantsDev && (opts.allowDev ?? true);
    if (canDev && ref.entryDev) {
        return { kind: "dev", source: ref.entryDev };
    }

    // 2) URL-Drop-in (gebautes Bundle)
    if (ref.baseUrl && ref.entry) {
        const absBase = toAbsoluteBase(ref.baseUrl)!;
        const source = /^https?:\/\//i.test(ref.entry)
            ? ref.entry
            : new URL(ref.entry, absBase).toString();
        return { kind: "url", source };
    }

    // 3) Package-Specifier (per Import-Map/CDN)
    if (ref.spec) {
        const isHttp = /^https?:\/\//i.test(ref.spec);
        const source = isHttp
            ? ref.spec
            : opts.resolveSpecifier
            ? await opts.resolveSpecifier(ref.spec)
            : ref.spec; // funktioniert nur mit Import-Map/Bundler
        return { kind: "spec", source };
    }

    return null;
}

/* ========================================================================== */
/* Einzelnes Modul ad-hoc laden                                               */
/* ========================================================================== */

export async function loadSingleModule(
    ctx: ModuleContext,
    ref: RemoteModuleRef,
    options: Omit<ModuleLoaderOptions, "manifestUrl" | "mapManifest"> = {}
) {
    const manifest: RemoteModuleRef[] = [ref];
    const tmpManifestUrl = URL.createObjectURL(
        new Blob([JSON.stringify(manifest)], { type: "application/json" })
    );
    const res = await loadRemoteModules(ctx, {
        ...options,
        manifestUrl: tmpManifestUrl,
    });
    URL.revokeObjectURL(tmpManifestUrl);
    return res;
}
