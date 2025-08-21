declare module "@stratton-cologne/remote-modules" {
    import type { App } from "vue";
    import type { Router, RouteRecordRaw } from "vue-router";
    import type { I18n } from "vue-i18n";
    import type { Pinia } from "pinia";

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
        /** '' | null → Root-Merge (ohne Namespace) */
        i18nNamespace?: string | null;
    };
}
