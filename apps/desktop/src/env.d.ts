/// <reference types="vite/client" />

interface Window {
  /** Presente apenas dentro do Electron (ver electron/preload.ts). */
  ragDesktop?: { hostUrl: string | null; info(): Promise<{ version: string; platform: string }> };
}
