import type { UserDTO } from '@rag/shared';
import { useSession } from './session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'ERROR',
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

interface Tokens {
  accessToken: string;
  refreshToken: string;
  user: UserDTO;
}

let refreshing: Promise<boolean> | null = null;

/** Renova o token de acesso uma única vez, mesmo com várias requisições falhando juntas. */
function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    const { serverUrl, refreshToken, setSession, clear } = useSession.getState();
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${serverUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) throw new Error('refresh recusado');
      setSession((await res.json()) as Tokens);
      return true;
    } catch {
      clear();
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}
export const refreshSession = refresh;

async function parseError(res: Response): Promise<ApiError> {
  let body: { error?: string; code?: string; issues?: { path: string; message: string }[] } = {};
  try {
    body = await res.json();
  } catch {
    /* sem corpo */
  }
  return new ApiError(res.status, body.error ?? `Erro ${res.status}`, body.code, body.issues);
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Corpo binário (upload). */
  binary?: BodyInit;
  query?: Record<string, string | undefined>;
  auth?: boolean;
}

export async function api<T = unknown>(path: string, o: RequestOptions = {}, retried = false): Promise<T> {
  const { serverUrl, accessToken, setOnline } = useSession.getState();
  const qs = o.query ? '?' + new URLSearchParams(Object.entries(o.query).filter(([, v]) => v !== undefined) as [string, string][]) : '';
  const headers: Record<string, string> = {};
  if (o.auth !== false && accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  if (o.binary !== undefined) headers['content-type'] = 'application/octet-stream';

  let res: Response;
  try {
    res = await fetch(`${serverUrl}${path}${qs}`, {
      method: o.method ?? (o.body !== undefined || o.binary !== undefined ? 'POST' : 'GET'),
      headers,
      body: o.binary ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined),
    });
  } catch {
    setOnline(false);
    throw new ApiError(0, 'Não foi possível conectar ao servidor. Verifique se o computador Host está ligado e o endereço está correto.', 'NETWORK');
  }
  setOnline(true);
  if (res.status === 401 && o.auth !== false && !retried && (await refresh())) return api<T>(path, o, true);
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Baixa um arquivo protegido (mídia) com o token e devolve uma URL local para <img>/<audio>. */
export async function fetchBlobUrl(path: string): Promise<string> {
  const { serverUrl, accessToken } = useSession.getState();
  const res = await fetch(`${serverUrl}${path}`, { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
  if (!res.ok) throw await parseError(res);
  return URL.createObjectURL(await res.blob());
}

export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Erro inesperado.');
