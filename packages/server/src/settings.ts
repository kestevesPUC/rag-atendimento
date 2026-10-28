import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { aiSettingsSchema, type AiSettings } from '@rag/shared';
import type { Db } from './db';

/** Guarda segredos (chave da API de IA). No Electron, a implementação usa `safeStorage`. */
export interface SecretStore {
  get(name: string): string | null;
  set(name: string, value: string | null): void;
}

/**
 * Implementação padrão: AES-256-GCM com uma chave mestra em arquivo (modo 0600 em POSIX).
 * É proteção em repouso modesta — quem tem acesso ao disco do Host tem a chave mestra junto.
 * Em produção no Electron, prefira o `SecretStore` baseado em `safeStorage` (decisão D-017).
 */
export class FileSecretStore implements SecretStore {
  private readonly secretsPath: string;
  private readonly keyPath: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.secretsPath = `${dir}/secrets.json`;
    this.keyPath = `${dir}/master.key`;
  }

  private masterKey(): Buffer {
    if (existsSync(this.keyPath)) return Buffer.from(readFileSync(this.keyPath, 'utf8'), 'hex');
    const key = randomBytes(32);
    mkdirSync(dirname(this.keyPath), { recursive: true });
    writeFileSync(this.keyPath, key.toString('hex'), { mode: 0o600 });
    try {
      chmodSync(this.keyPath, 0o600);
    } catch {
      /* Windows: permissões POSIX não se aplicam */
    }
    return key;
  }

  private readAll(): Record<string, string> {
    return existsSync(this.secretsPath) ? (JSON.parse(readFileSync(this.secretsPath, 'utf8')) as Record<string, string>) : {};
  }

  get(name: string): string | null {
    const blob = this.readAll()[name];
    if (!blob) return null;
    try {
      const raw = Buffer.from(blob, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', this.masterKey(), raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      return null; // chave mestra trocada ou arquivo corrompido: tratado como "não configurada"
    }
  }

  set(name: string, value: string | null): void {
    const all = this.readAll();
    if (value === null) delete all[name];
    else {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.masterKey(), iv);
      const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      all[name] = Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
    }
    writeFileSync(this.secretsPath, JSON.stringify(all), { mode: 0o600 });
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly m = new Map<string, string>();
  get = (n: string) => this.m.get(n) ?? null;
  set = (n: string, v: string | null) => void (v === null ? this.m.delete(n) : this.m.set(n, v));
}

export const SECRET_LLM_KEY = 'llm_api_key';

/** Configurações editáveis pelo admin, guardadas como JSON na tabela `settings`. */
export class SettingsService {
  constructor(private readonly db: Db) {}

  getAi(): AiSettings {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = 'ai'`).get() as { value: string } | undefined;
    const parsed = aiSettingsSchema.safeParse(row ? JSON.parse(row.value) : {});
    return parsed.success ? parsed.data : aiSettingsSchema.parse({});
  }

  setAi(input: unknown): AiSettings {
    const next = aiSettingsSchema.parse({ ...this.getAi(), ...(input as object) });
    this.db
      .prepare(`INSERT INTO settings(key, value) VALUES('ai', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(next));
    return next;
  }
}
