import { contextBridge, ipcRenderer } from 'electron';

// Exposição mínima e somente leitura: o renderer não recebe acesso ao Node nem ao ipcRenderer.
const arg = process.argv.find((a) => a.startsWith('--rag-host-url='));
const hostUrl = arg ? arg.slice('--rag-host-url='.length) || null : null;

contextBridge.exposeInMainWorld('ragDesktop', {
  hostUrl,
  info: () => ipcRenderer.invoke('app:info') as Promise<{ version: string; platform: string }>,
});
