import { randomUUID } from 'node:crypto';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'ERROR',
  ) {
    super(message);
  }
}
export const notFound = (what = 'Recurso') => new HttpError(404, `${what} não encontrado.`, 'NOT_FOUND');
export const forbidden = (msg = 'Você não tem permissão para esta ação.') => new HttpError(403, msg, 'FORBIDDEN');
export const conflict = (msg: string) => new HttpError(409, msg, 'CONFLICT');
export const badRequest = (msg: string) => new HttpError(400, msg, 'BAD_REQUEST');

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export const newId = (): string => randomUUID();
export const iso = (d: Date): string => d.toISOString();
export const addMinutes = (d: Date, min: number): Date => new Date(d.getTime() + min * 60_000);

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}
export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export const parseJson = <T>(raw: string | null | undefined, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};
