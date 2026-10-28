import type { UserDTO } from '@rag/shared';
import { create } from 'zustand';

const LS = {
  server: 'rag.serverUrl',
  refresh: 'rag.refreshToken',
  theme: 'rag.theme',
};
const read = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null; // armazenamento bloqueado: o app funciona, só não lembra
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* sem persistência */
  }
};

export type Theme = 'system' | 'light' | 'dark';

interface SessionState {
  serverUrl: string;
  /** Só em memória: após recarregar, é renovado pelo refresh token. */
  accessToken: string | null;
  refreshToken: string | null;
  user: UserDTO | null;
  theme: Theme;
  online: boolean;
  setServerUrl(url: string): void;
  setSession(s: { accessToken: string; refreshToken: string; user: UserDTO }): void;
  setTokens(s: { accessToken: string; refreshToken: string }): void;
  clear(): void;
  setTheme(t: Theme): void;
  setOnline(v: boolean): void;
}

export const normalizeUrl = (u: string): string => {
  const t = u.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
};

export const applyTheme = (t: Theme) => {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
};

export const useSession = create<SessionState>((set) => ({
  // No modo Host do Electron o servidor é local e tem prioridade; senão, o último endereço usado.
  serverUrl: window.ragDesktop?.hostUrl ?? read(LS.server) ?? 'http://127.0.0.1:3333',
  accessToken: null,
  refreshToken: read(LS.refresh),
  user: null,
  theme: (read(LS.theme) as Theme | null) ?? 'system',
  online: true,
  setServerUrl: (url) => {
    const v = normalizeUrl(url);
    write(LS.server, v);
    set({ serverUrl: v });
  },
  setSession: ({ accessToken, refreshToken, user }) => {
    write(LS.refresh, refreshToken);
    set({ accessToken, refreshToken, user });
  },
  setTokens: ({ accessToken, refreshToken }) => {
    write(LS.refresh, refreshToken);
    set({ accessToken, refreshToken });
  },
  clear: () => {
    write(LS.refresh, null);
    set({ accessToken: null, refreshToken: null, user: null });
  },
  setTheme: (theme) => {
    write(LS.theme, theme);
    applyTheme(theme);
    set({ theme });
  },
  setOnline: (online) => set({ online }),
}));
