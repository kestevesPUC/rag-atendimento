import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { Role, UserDTO } from '@rag/shared';
import type { SecretStore } from './settings';
import type { UserRepo } from './repos';
import { HttpError, type Clock } from './util';

export interface AuthUser {
  id: string;
  name: string;
  displayName: string;
  role: Role;
  sectorId: string | null;
}

const ACCESS_TTL = '15m';
const REFRESH_TTL = '7d';
const MAX_FAILURES = 5;
const WINDOW_MS = 10 * 60_000;
// Padrão 10. A variável existe só para acelerar os testes; nunca abaixo de 4 (mínimo do bcrypt).
const BCRYPT_COST = Math.max(4, Number(process.env.BCRYPT_COST ?? 10) || 10);
// Hash fixo para gastar o mesmo tempo quando o e-mail não existe (evita enumerar usuários por tempo de resposta).
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', BCRYPT_COST);

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, BCRYPT_COST);

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  user: UserDTO;
}

export class AuthService {
  private readonly failures = new Map<string, number[]>();
  private readonly secret: string;

  constructor(private readonly users: UserRepo, secrets: SecretStore, private readonly clock: Clock) {
    let s = secrets.get('jwt_secret');
    if (!s) {
      s = randomBytes(48).toString('hex');
      secrets.set('jwt_secret', s);
    }
    this.secret = s;
  }

  private recentFailures(key: string): number[] {
    const cutoff = this.clock.now().getTime() - WINDOW_MS;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    this.failures.set(key, list);
    return list;
  }

  async login(email: string, password: string, ip = 'local'): Promise<Tokens> {
    const key = `${email.toLowerCase()}|${ip}`;
    if (this.recentFailures(key).length >= MAX_FAILURES) {
      throw new HttpError(429, 'Muitas tentativas. Aguarde alguns minutos e tente novamente.', 'RATE_LIMITED');
    }
    const row = this.users.byEmail(email);
    const ok = await bcrypt.compare(password, row?.password_hash ?? DUMMY_HASH);
    if (!row || !ok || !row.active) {
      this.recentFailures(key).push(this.clock.now().getTime());
      throw new HttpError(401, 'E-mail ou senha inválidos.', 'INVALID_CREDENTIALS');
    }
    this.failures.delete(key);
    return this.issue(row.id);
  }

  private issue(userId: string): Tokens {
    const row = this.users.row(userId)!;
    const base = { sub: row.id, tv: row.token_version };
    return {
      accessToken: jwt.sign({ ...base, typ: 'access', role: row.role, sid: row.sector_id }, this.secret, { expiresIn: ACCESS_TTL }),
      refreshToken: jwt.sign({ ...base, typ: 'refresh' }, this.secret, { expiresIn: REFRESH_TTL }),
      user: this.users.list().find((u) => u.id === userId)!,
    };
  }

  refresh(refreshToken: string): Tokens {
    const claims = this.decode(refreshToken, 'refresh');
    return this.issue(claims.sub);
  }

  private decode(token: string, typ: 'access' | 'refresh'): { sub: string; tv: number } {
    try {
      const c = jwt.verify(token, this.secret) as { sub: string; tv: number; typ: string };
      if (c.typ !== typ) throw new Error('tipo');
      const row = this.users.row(c.sub);
      if (!row || !row.active || row.token_version !== c.tv) throw new Error('revogado');
      return c;
    } catch {
      throw new HttpError(401, 'Sessão inválida ou expirada.', 'UNAUTHENTICATED');
    }
  }

  /**
   * Autentica um token de acesso. Papel e setor vêm do BANCO (não do token), então mudanças de
   * permissão valem imediatamente — o isolamento por setor não depende de claims antigas (RNF06).
   */
  authenticate(accessToken: string): AuthUser {
    const c = this.decode(accessToken, 'access');
    const row = this.users.row(c.sub)!;
    return { id: row.id, name: row.name, displayName: row.display_name, role: row.role, sectorId: row.sector_id };
  }
}

export const isAdmin = (u: AuthUser) => u.role === 'ADMIN';
export const isSupervisorOrAdmin = (u: AuthUser) => u.role === 'ADMIN' || u.role === 'SUPERVISOR';
