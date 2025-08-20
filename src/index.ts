/**
 * @file Runtime-Loader für externe ESM-Module in Vue 3 Apps.
 * Lädt ein Manifest (index.json), importiert Bundles (index.js), bindet CSS,
 * registriert Routen, merged i18n-Locales und ruft optionale install()-Hooks auf.
 */

import type { App } from "vue";
import type { Router, RouteRecordRaw } from "vue-router";
import type { I18n } from "vue-i18n";
import type { Pinia } from "pinia";

// ---------------------------------------------------------
// Typen (Contract zwischen Host und Modul)
// ---------------------------------------------------------

export type ModuleContext = {
    app: App;
    router: Router;
    i18n: I18n;
    pinia: Pinia;
};

export type ModuleBundle = {
    /** Modulname; wird als i18n-Namespaceschlüssel genutzt */
    name: string;
    /** Modulversion (z.B. "1.2.3") – nur Information/Logging */
    version: string;
    /** Vollständige Route(n) – Parent/Children erlaubt, inkl. meta (z.B. roles) */
    routes?: RouteRecordRaw[];
    /** Lokalisierungen: { de: {...}, en: {...} } – wird unter [name] gemerged */
    locales?: Record<string, any>;
    /** Optionaler Hook für beliebige App-Registrierungen (Plugins, Components, …) */
    install?: (ctx: ModuleContext) => void;
    /** Optionaler Cleanup-Hook für zukünftiges Unload/Switching */
    onUnload?: () => void;
};

export type RemoteModuleRef = {
    /** "admin" */
    name: string;
    /** "1.2.3" */
    version: string;
    /** Basis-URL, z.B. "/modules/admin/1.2.3/" */
    baseUrl: string;
    /** Haupteinstieg, z.B. "index.js" */
    entry: string;
    /** Optionale Stylesheet-Dateien im selben Ordner, z.B. ["style.css"] */
    styles?: string[];
};

export type NamespaceStrategy =
    | "moduleName"
    | ((moduleName: string, bundle: ModuleBundle) => string);

export type DuplicateRouteGuard = "name" | "path" | false;

export type ModuleLoaderOptions = {
    /**
     * URL zum Manifest (Default: "/modules/index.json")
     */
    manifestUrl?: string;
    /**
     * Eigener fetch (z.B. mit CORS/Credentials)
     */
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    /**
     * i18n-Namespace-Strategie (Default: 'moduleName' → <bundle.name>)
     */
    i18nNamespaceStrategy?: NamespaceStrategy;
    /**
     * Doppelte Routen abfangen.
     * - "name" (Default): überspringt Route, wenn Name bereits existiert
     * - "path": überspringt Route, wenn Pfad bereits existiert
     * - false: keine Prüfung
     */
    guardDuplicateRoutes?: DuplicateRouteGuard;
    /**
     * Callback pro erfolgreich geladenem Modul
     */
    onModuleLoaded?: (bundle: ModuleBundle, ref: RemoteModuleRef) => void;
    /**
     * Callback bei einem Fehler
     */
    onModuleError?: (ref: RemoteModuleRef, error: unknown) => void;
    /**
     * Vor dem Import können Einträge optional gefiltert/umgeschrieben werden
     */
    mapManifest?: (refs: RemoteModuleRef[]) => RemoteModuleRef[];
    /**
     * Optional: Log-Funktion
     */
    log?: (level: "info" | "warn" | "error", ...args: any[]) => void;
};

/** Ergebnis des Ladevorgangs */
export type LoadResult = {
    loaded: Array<{ bundle: ModuleBundle; ref: RemoteModuleRef }>;
    errors: Array<{ ref: RemoteModuleRef; error: unknown }>;
};

// ---------------------------------------------------------
// Utils
// ---------------------------------------------------------

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

function mergeLocales(
    i18n: I18n,
    namespace: string,
    locales: Record<string, any>
) {
    for (const [lang, msgs] of Object.entries(locales)) {
        const current = (i18n.global as any).getLocaleMessage(lang) || {};
        (i18n.global as any).setLocaleMessage(lang, {
            ...current,
            [namespace]: msgs,
        });
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

// ---------------------------------------------------------
// Core: loadRemoteModules
// ---------------------------------------------------------

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
    const {
        app,
        router,
        i18n,
        pinia, // eslint-disable-line @typescript-eslint/no-unused-vars
    } = ctx;

    const fetchImpl = options.fetch ?? fetch.bind(window);
    const manifestUrl = options.manifestUrl ?? "/modules/index.json";
    const nsStrategy: NamespaceStrategy =
        options.i18nNamespaceStrategy ?? "moduleName";
    const guard: DuplicateRouteGuard = options.guardDuplicateRoutes ?? "name";
    const log = options.log ?? defaultLog;

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
            // 1) optional Styles laden
            for (const s of ensureArray(ref.styles)) {
                loadCss(new URL(s, ref.baseUrl).toString());
            }

            // 2) ESM importieren
            const entryUrl = new URL(ref.entry, ref.baseUrl).toString();
            const mod = (await import(/* @vite-ignore */ entryUrl)) as {
                default?: ModuleBundle;
            };
            const bundle = mod?.default;
            if (!bundle || !bundle.name) {
                throw new Error(
                    "Ungültiges Bundle: default export fehlt oder name leer"
                );
            }

            // 3) i18n mergen (Namespace = Modulname oder Strategie)
            if (bundle.locales) {
                const ns =
                    nsStrategy === "moduleName"
                        ? bundle.name
                        : (nsStrategy as Function)(bundle.name, bundle);
                mergeLocales(i18n, ns, bundle.locales);
            }

            // 4) Routen registrieren
            if (Array.isArray(bundle.routes)) {
                for (const route of bundle.routes) {
                    // Duplikate optional abfangen
                    if (
                        guard === "name" &&
                        route.name &&
                        router.hasRoute(route.name)
                    ) {
                        log(
                            "warn",
                            `Route-Name bereits vorhanden, übersprungen: ${String(
                                route.name
                            )}`
                        );
                        continue;
                    }
                    if (
                        guard === "path" &&
                        route.path &&
                        routerHasPath(router, route.path)
                    ) {
                        log(
                            "warn",
                            `Route-Pfad bereits vorhanden, übersprungen: ${route.path}`
                        );
                        continue;
                    }
                    router.addRoute(route);
                }
            }

            // 5) Install-Hook
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

// ---------------------------------------------------------
// Zusatz: Hilfs-API, falls du einzelne Bundles direkt laden willst
// ---------------------------------------------------------

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
