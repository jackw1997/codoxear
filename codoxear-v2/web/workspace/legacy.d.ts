declare module "*legacy/app_application.js" {
  export function configureAppUrlResolver(
    resolver: (path: string, base: URL) => string,
  ): void;
  export function createApplicationController(
    options: Record<string, unknown>,
  ): {
    api(path: string): Promise<unknown>;
    renderApp(): void;
    renderLogin(onAuthed: () => void): void;
    cleanupActiveApp(): void;
  };
}
declare module "*legacy/app_transcript.js" {
  export function configureTailCacheFactory(
    factory: () => Map<string, unknown>,
  ): void;
}
declare module "*legacy/app_session_lifecycle.js" {
  export function configureSessionAccessCheck(
    check: (id: string) => Promise<void>,
  ): void;
}
declare module "*legacy/app_file_access_context.js" {
  export function configureFileAccessContext(key: (id: string | null) => string): void;
  export function notifyFileAccessContext(id: string): void;
}
declare module "*legacy/app_theme.js" {
  export function createThemeController(options: {
    documentTarget: Document;
    storageGetItem: (key: string) => string | null;
    storageSetItem: (key: string, value: string) => boolean;
    storageRemoveItem: (key: string) => void;
    matchMedia: (query: string) => MediaQueryList;
    versionedAssetPath: (path: string) => string;
  }): unknown;
}

declare module "*legacy/app_session_refresh.js" {
  export function configureSessionDiscoveryObserver(
    observer: ((state: any, retry: () => Promise<unknown>) => void) | null,
  ): void;
}
