/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Send runtime activity to the server as well as recording it locally.
   * Off unless set to 1/true/on. Baked in at BUILD time, like every VITE_ var —
   * changing it needs a rebuild, not just a restart.
   */
  readonly VITE_SERVER_ACTIVITY_LOG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
