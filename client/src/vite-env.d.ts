/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Origin of the API server, e.g. `http://localhost:3001`. */
  readonly VITE_SERVER_ORIGIN?: string;
  /** Must match the server's PAGE_DPI so 100% zoom is true page size. */
  readonly VITE_PAGE_DPI?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
