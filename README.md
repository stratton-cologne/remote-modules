# @stratton-cologne/remote-modules

Runtime‑Loader für **Vue 3 + Vite**: lädt externe **ESM‑Module** (Routes, i18n, CSS) zur Laufzeit aus einem Manifest
(z. B. `/modules/index.json`). Ideal für **Drop‑in‑Module**, die separat entwickelt/gebaut und ohne Rebuild der Host‑App deployed werden.

---

## Installation

```bash
npm i @stratton-cologne/remote-modules
# oder
pnpm add @stratton-cologne/remote-modules
```

---

## Quick Start (Host‑App)

**src/main.ts**

```ts
import { createApp } from "vue";
import App from "./app.vue";
import router from "./router";
import { createPinia } from "pinia";
import i18n from "./i18n";
import { loadRemoteModules } from "@stratton-cologne/remote-modules";

async function bootstrap() {
    const app = createApp(App);
    const pinia = createPinia();

    await loadRemoteModules(
        { app, router, i18n, pinia },
        {
            manifestUrl: "/modules/index.json",
            guardDuplicateRoutes: "name", // Default – siehe unten
        }
    );

    app.use(pinia);
    app.use(i18n);
    app.use(router);

    app.mount("#app");
}
bootstrap();
```

**/public/modules/index.json**

```json
[
    {
        "name": "admin",
        "version": "1.2.3",
        "baseUrl": "/modules/admin/1.2.3/",
        "entry": "index.js",
        "styles": ["style.css"]
    }
]
```

**Was macht der Loader?**

-   lädt `style.css` (falls vorhanden) via `<link>`
-   importiert `index.js` (ESM, `default` = `ModuleBundle`)
-   merged `locales` unter **Namespace = Modulname** → `t('admin.*')`
-   registriert `routes` (inkl. Parent/Children, `meta.roles` etc.)
-   ruft optional `install({ app, router, i18n, pinia })`

---

## Entwicklungsmodi (Dev)

### A) **Runtime‑only Dev** (Host nicht gebaut)

-   Setze `.env.development` (oder eine Flag in deinem Code) so, dass **nur** der Runtime‑Loader verwendet wird.
-   Lege das gebaute Modul unter:

    ```text
    /public/modules/<name>/<version>/
      ├─ index.js
      ├─ style.css (optional)
      └─ assets/ (optional)
    ```

-   Aktualisiere `/public/modules/index.json` (per Script oder manuell).
-   Starte den Vite‑Dev‑Server der Host‑App → der Loader importiert direkt aus `/public/modules/...`.
-   Tipp: Browser‑Reload reicht; der Loader lädt das Manifest mit `cache: 'no-cache'`.

### B) **Mixed Dev** (lokale Build‑Time‑Module + Remote gleichzeitig)

-   Lasse deinen bestehenden Build‑Time‑Autoloader aktiv **und** rufe zusätzlich `loadRemoteModules(...)` auf.
-   Belasse `guardDuplicateRoutes: 'name'` (Default), damit Remote‑Routen mit **gleichem Namen** leise übersprungen werden.
-   Achte auf eindeutige Route‑Namen (z. B. Prefix `admin-*`).
-   Optional: `mapManifest` nutzen, um bestimmte Remote‑Einträge in Dev zu filtern:

    ```ts
    await loadRemoteModules(
        { app, router, i18n, pinia },
        {
            mapManifest: (refs) => refs.filter((r) => r.name !== "admin"),
        }
    );
    ```

---

## Option: `guardDuplicateRoutes`

```ts
await loadRemoteModules(ctx, {
    guardDuplicateRoutes: "name" | "path" | false,
});
```

-   **'name' (Default):** Wenn `route.name` bereits existiert (`router.hasRoute(name)`), wird die Remote‑Route **übersprungen**.
    _Fallback_: Falls eine Route **keinen Namen** hat, prüft der Loader zusätzlich den **Pfad** und überspringt bei identischem Pfad.
-   **'path':** Prüft ausschließlich den **Pfad** via `router.getRoutes()`.
-   **false:** **keine** Duplikatsprüfung (nicht empfohlen bei Mixed‑Setups).

> Zweck: verhindert doppelte Registrierung, wenn dieselbe Route bereits lokal (Build‑Time) existiert.

---

## Modul‑Contract

Ein Modul exportiert **default** ein `ModuleBundle`:

```ts
// public-entry.ts (im Modul‑Projekt)
import type { ModuleBundle } from "@stratton-cologne/remote-modules";
import de from "./locales/de.json";
import en from "./locales/en.json";

const bundle: ModuleBundle = {
    name: "admin",
    version: "1.2.3",
    routes: [
        {
            path: "/admin",
            component: () => import("./layouts/admin.layout.vue"),
            meta: { title: "Admin", roles: ["admin"] },
            children: [
                {
                    path: "",
                    name: "admin-index",
                    component: () => import("./views/index.view.vue"),
                },
            ],
        },
    ],
    locales: { de, en },
    install({ app /*, router, i18n, pinia */ }) {
        // optional: Plugins/Components registrieren
    },
};
export default bundle;
```

---

## Vite Library‑Build (im Modul‑Projekt)

```ts
// vite.config.ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
    plugins: [vue()],
    build: {
        lib: {
            entry: "src/public-entry.ts",
            formats: ["es"],
            fileName: () => "index.js",
        },
        rollupOptions: {
            external: ["vue", "vue-router", "pinia", "vue-i18n"], // Host liefert diese zur Laufzeit
            output: { assetFileNames: "assets/[name]-[hash][extname]" },
        },
        cssCodeSplit: true,
    },
});
```

**Deploy:** Kopiere das Modul‑`dist/` nach `/public/modules/<name>/<version>/` in der Host‑App und pflege `index.json`.

---

## Erweiterte Nutzung

```ts
await loadRemoteModules({ app, router, i18n, pinia }, {
  manifestUrl: '/modules/index.json',  // Pfad zum Manifest (Default)
  fetch: customFetch,                  // eigener fetch (z. B. mit Credentials/CORS)
  i18nNamespaceStrategy: 'moduleName'  // oder (name, bundle) => string
  // guardDuplicateRoutes: 'name',     // s. o.
  onModuleLoaded: (bundle, ref) => {},
  onModuleError:  (ref, err) => {},
  mapManifest: (refs) => refs.filter(/* ... */),
  log: (level, ...args) => {}          // eigenes Logging
})
```

---

## Vollständiger Source (Package‑Entry)

> **Neu:** unterstützt jetzt drei Quellen pro Modul‑Eintrag
>
> 1. **URL‑Drop‑in** (`baseUrl` + `entry`) – gebautes Bundle aus `/modules/...`
> 2. **Dev‑Quelle** (`entryDev`) – z. B. Vite‑Pfad `/@fs/.../src/public-entry.ts`
> 3. **Package‑Specifier** (`spec`) – z. B. `"@org/module-admin"` (per Import‑Map/CDN)

```ts
/** src/index.ts */
import type { App } from "vue";
import type { Router, RouteRecordRaw } from "vue-router";
import type { I18n } from "vue-i18n";
import type { Pinia } from "pinia";

// -------------------------------------
// Typen (Contract & Optionen)
// -------------------------------------
export type ModuleContext = {
    app: App;
    router: Router;
    i18n: I18n;
    pinia: Pinia;
};

export type ModuleBundle = {
    name: string;
    version: string;
    routes?: RouteRecordRaw[];
    locales?: Record<string, any>;
    install?: (ctx: ModuleContext) => void;
    onUnload?: () => void;
};

export type RemoteModuleRef = {
    name: string;
    version: string;
    // Variante A: URL‑Drop‑in
    baseUrl?: string; // z. B. "/modules/admin/1.2.3/"
    entry?: string; // z. B. "index.js"
    styles?: string[]; // optional CSS relativ zu baseUrl
    // Variante B: Dev‑Quelle (Vite wandelt TS/Vue)
    entryDev?: string; // z. B. "/@fs/…/admin-module/src/public-entry.ts"
    // Variante C: Package‑Specifier
    spec?: string; // z. B. "@org/module-admin" oder vollständige https‑URL
    // Priorisierung (optional)
    prefer?: "dev" | "url" | "spec";
};

export type NamespaceStrategy =
    | "moduleName"
    | ((moduleName: string, bundle: ModuleBundle) => string);
export type DuplicateRouteGuard = "name" | "path" | false;

export type ModuleLoaderOptions = {
    manifestUrl?: string;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    i18nNamespaceStrategy?: NamespaceStrategy;
    guardDuplicateRoutes?: DuplicateRouteGuard;
    onModuleLoaded?: (bundle: ModuleBundle, ref: RemoteModuleRef) => void;
    onModuleError?: (ref: RemoteModuleRef, error: unknown) => void;
    mapManifest?: (refs: RemoteModuleRef[]) => RemoteModuleRef[];
    log?: (level: "info" | "warn" | "error", ...args: any[]) => void;
    /**
     * Bevorzugt Dev‑Einträge (entryDev), wenn vorhanden.
     * Default: true in Dev, false in Prod.
     */
    preferDevEntries?: boolean;
    /**
     * Bare Specifier → URL auflösen (falls keine Import‑Map genutzt wird)
     * z. B. speisen auf CDN wie esm.sh / jsdelivr
     */
    resolveSpecifier?: (spec: string) => string | Promise<string>;
    /** Dev‑Einträge auch in Prod erlauben (normalerweise false) */
    allowDevEntryInProd?: boolean;
};

export type LoadResult = {
    loaded: Array<{ bundle: ModuleBundle; ref: RemoteModuleRef }>;
    errors: Array<{ ref: RemoteModuleRef; error: unknown }>;
};

// -------------------------------------
// Utils
// -------------------------------------
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
    return !v ? [] : Array.isArray(v) ? v : [v];
}
function routerHasPath(router: Router, path: string): boolean {
    return router.getRoutes().some((r) => r.path === path);
}

// -------------------------------------
// Core
// -------------------------------------
export async function loadRemoteModules(
    ctx: ModuleContext,
    options: ModuleLoaderOptions = {}
): Promise<LoadResult> {
    const { app, router, i18n, pinia } = ctx;
    const fetchImpl = options.fetch ?? fetch.bind(window);
    const manifestUrl = options.manifestUrl ?? "/modules/index.json";
    const nsStrategy = options.i18nNamespaceStrategy ?? "moduleName";
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
    if (typeof options.mapManifest === "function")
        refs = options.mapManifest(refs);

    for (const ref of refs) {
        try {
            // 1) Styles laden (nur bei URL‑Drop‑ins relevant)
            for (const s of ensureArray(ref.styles)) {
                if (ref.baseUrl) loadCss(new URL(s, ref.baseUrl).toString());
            }

            // 2) Entry auflösen (Dev → URL → Spec)
            const entryInfo = await resolveEntry(ref, {
                preferDev,
                allowDev: options.allowDevEntryInProd,
                resolveSpecifier: options.resolveSpecifier,
            });
            if (!entryInfo) {
                log("warn", `Kein gültiger Entry für Modul ${ref.name}`);
                continue;
            }

            // 3) ESM importieren
            const mod = (await import(/* @vite-ignore */ entryInfo.source)) as {
                default?: ModuleBundle;
            };
            const bundle = mod?.default;
            if (!bundle || !bundle.name)
                throw new Error(
                    "Ungültiges Bundle: default export fehlt oder name leer"
                );

            // 4) i18n
            if (bundle.locales) {
                const ns =
                    nsStrategy === "moduleName"
                        ? bundle.name
                        : (nsStrategy as Function)(bundle.name, bundle);
                mergeLocales(i18n, ns, bundle.locales);
            }

            // 5) Routen
            if (Array.isArray(bundle.routes)) {
                for (const route of bundle.routes) {
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

            // 6) Install‑Hook
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

// Entry‑Resolver
async function resolveEntry(
    ref: RemoteModuleRef,
    opts: {
        preferDev: boolean;
        allowDev?: boolean;
        resolveSpecifier?: (s: string) => string | Promise<string>;
    }
): Promise<{ kind: "dev" | "url" | "spec"; source: string } | null> {
    const wantsDev = opts.preferDev && !!ref.entryDev;
    const canDev = wantsDev && (opts.allowDev ?? true);
    if (canDev && ref.entryDev) return { kind: "dev", source: ref.entryDev };

    if (ref.baseUrl && ref.entry) {
        return {
            kind: "url",
            source: new URL(ref.entry, ref.baseUrl).toString(),
        };
    }

    if (ref.spec) {
        const isHttp = /^https?:\/\//i.test(ref.spec);
        const specUrl = isHttp
            ? ref.spec
            : opts.resolveSpecifier
            ? await opts.resolveSpecifier(ref.spec)
            : ref.spec;
        return { kind: "spec", source: specUrl };
    }

    return null;
}

// Einzelnes Modul ad‑hoc laden
export async function loadSingleModule(
    ctx: ModuleContext,
    ref: RemoteModuleRef,
    options: Omit<ModuleLoaderOptions, "manifestUrl" | "mapManifest"> = {}
) {
    const manifest: RemoteModuleRef[] = [ref];
    const tmp = URL.createObjectURL(
        new Blob([JSON.stringify(manifest)], { type: "application/json" })
    );
    const res = await loadRemoteModules(ctx, { ...options, manifestUrl: tmp });
    URL.revokeObjectURL(tmp);
    return res;
}
```

---

## Weitere Beispiele & Setup

### 1) **Ungebaute** Module im Dev testen (Vite‑Pfad)

-   Baue im Modul‑Repo **nicht** – nutze den Quell‑Entry `src/public-entry.ts`.
-   Trage in `/public/modules/index.json` des Hosts einen Dev‑Eintrag ein:

```json
[
    {
        "name": "admin",
        "version": "dev",
        "entryDev": "/@fs/ABSOLUTER/PFAD/zu/admin-module/src/public-entry.ts"
    }
]
```

-   **Host `vite.config.ts`**: Zugriff auf den Modul‑Ordner erlauben

```ts
// vite.config.ts (Host)
export default defineConfig({
    server: {
        fs: { allow: ["..", "/ABSOLUTER/PFAD/zu/admin-module"] },
    },
});
```

-   **Loader‑Option** (optional – in Dev schon default):

```ts
await loadRemoteModules(ctx, { preferDevEntries: true });
```

> Vite transformiert TS/SFC automatisch, da `/@fs/...` über den Dev‑Server läuft.

### 2) Module als **Packages** (ohne Rebuild der Host‑App)

Variante A – **Import‑Map** (empfohlen):

```html
<!-- index.html des Hosts -->
<script type="importmap">
    {
        "imports": {
            "@org/module-admin": "/modules/npm/module-admin/1.2.3/index.js"
        }
    }
</script>
```

Manifest‑Eintrag:

```json
[{ "name": "admin", "version": "1.2.3", "spec": "@org/module-admin" }]
```

Variante B – **CDN‑URL** (esm.sh/jsDelivr):

```json
[
    {
        "name": "admin",
        "version": "1.2.3",
        "spec": "https://esm.sh/@org/module-admin@1.2.3"
    }
]
```

Variante C – **eigene Auflösung**:

```ts
await loadRemoteModules(ctx, {
    resolveSpecifier: (spec) => `https://cdn.example.com/npm/${spec}/index.js`,
});
```

> Hinweis: Bare Specifier funktionieren im Browser nur, wenn sie per **Import‑Map** oder via Bundler/CDN‑URL aufgelöst werden.

---

## Lizenz

MIT
