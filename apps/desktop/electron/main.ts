import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, session, shell, utilityProcess, type UtilityProcess } from 'electron';

/**
 * Processo principal do Electron.
 * ATENÇÃO — não verificado nesta entrega: o modo Host (servidor embutido) exige um bundle do
 * servidor (RAG_SERVER_ENTRY) com better-sqlite3 recompilado para a ABI do Electron. Em
 * desenvolvimento, rode o servidor com Node (`pnpm dev:server`) e use o app como Cliente.
 */
interface AppConfig {
  mode: 'host' | 'client';
  /** Interface em que o Host escuta. Padrão local: a API ainda não tem TLS (decisão D-027). */
  listen: '127.0.0.1' | '0.0.0.0';
  port: number;
}

const DEFAULT_PORT = 3333;
const configPath = () => join(app.getPath('userData'), 'config.json');

function loadConfig(): AppConfig | null {
  try {
    return existsSync(configPath()) ? (JSON.parse(readFileSync(configPath(), 'utf8')) as AppConfig) : null;
  } catch {
    return null;
  }
}
function saveConfig(c: AppConfig) {
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(c, null, 2));
}

/** Assistente de primeira execução (doc 02 §7): "Esta máquina será o Host?" */
function firstRun(): AppConfig {
  const choice = dialog.showMessageBoxSync({
    type: 'question',
    title: 'RAG Atendimento — primeira execução',
    message: 'Esta máquina será o Host?',
    detail:
      'O Host fica ligado durante o atendimento: guarda os dados, conecta o WhatsApp e executa a IA. Os demais computadores se conectam a ele como Clientes.\n\nEscolha “Cliente” se outro computador já é o Host.',
    buttons: ['Sim, este é o Host', 'Não, sou Cliente'],
    defaultId: 1,
    cancelId: 1,
  });
  const cfg: AppConfig = { mode: choice === 0 ? 'host' : 'client', listen: '127.0.0.1', port: DEFAULT_PORT };
  saveConfig(cfg);
  return cfg;
}

let win: BrowserWindow | null = null;
let hostProc: UtilityProcess | null = null;
let blocker: number | null = null;

function startHost(cfg: AppConfig): string | null {
  const entry = process.env.RAG_SERVER_ENTRY ?? join(process.resourcesPath ?? '', 'server', 'main.cjs');
  if (!existsSync(entry)) {
    dialog.showErrorBox('Modo Host indisponível', `O servidor embutido não foi encontrado em:\n${entry}\n\nNesta compilação, execute o servidor separadamente e use o app como Cliente.`);
    return null;
  }
  hostProc = utilityProcess.fork(entry, [], {
    env: { ...process.env, DATA_DIR: join(app.getPath('userData'), 'data'), PORT: String(cfg.port), HOST: cfg.listen, WA_MODE: 'real' },
    stdio: 'inherit',
  });
  hostProc.on('exit', (code) => {
    hostProc = null;
    if (!app.isReady() || BrowserWindow.getAllWindows().length === 0) return;
    dialog.showErrorBox('Servidor encerrado', `O servidor embutido parou (código ${code}). Reinicie o aplicativo.`);
  });
  blocker = powerSaveBlocker.start('prevent-app-suspension'); // o Host não pode dormir em horário de atendimento
  return `http://127.0.0.1:${cfg.port}`;
}

function createWindow(hostUrl: string | null) {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0b1f44',
    title: 'RAG Atendimento',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--rag-host-url=${hostUrl ?? ''}`],
    },
  });
  // Nada de abrir janelas ou navegar para fora do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.VITE_DEV_SERVER_URL;
    if (!(dev && url.startsWith(dev)) && !url.startsWith('file://')) e.preventDefault();
  });
  win.on('close', (e) => {
    if (hostProc && win && dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Fechar mesmo assim', 'Cancelar'], defaultId: 1, cancelId: 1, title: 'Fechar o Host?',
      message: 'Este computador é o Host.', detail: 'Se fechar, o WhatsApp e a IA param de atender e os demais computadores perdem a conexão.',
    }) === 1) e.preventDefault();
  });

  const dev = process.env.VITE_DEV_SERVER_URL ?? (app.isPackaged ? null : 'http://localhost:5173');
  if (dev) void win.loadURL(dev);
  else void win.loadFile(join(__dirname, '..', 'dist', 'index.html'));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  void app.whenReady().then(() => {
    // Só notificações são permitidas; câmera, microfone, etc. ficam negados.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'notifications'));
    ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform }));

    const cfg = loadConfig() ?? firstRun();
    const hostUrl = cfg.mode === 'host' ? startHost(cfg) : null;
    createWindow(hostUrl);
  });

  app.on('window-all-closed', () => {
    if (blocker !== null) powerSaveBlocker.stop(blocker);
    hostProc?.kill();
    app.quit();
  });
}
