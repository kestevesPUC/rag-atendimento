import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny, z } from 'zod';
import type { AuthUser } from './auth';
import type { Services } from './context';
import { forbidden } from './util';

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser;
  }
}

export type Role = AuthUser['role'];

/** Valida e converte; erros do Zod viram 400 pelo manipulador global. */
export const parse = <S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> => schema.parse(data);

export const requireRole = (user: AuthUser, ...roles: Role[]): void => {
  if (!roles.includes(user.role)) throw forbidden();
};

export type Routes = (app: FastifyInstance, s: Services) => void;
export type Handler<T = unknown> = (req: FastifyRequest, reply: FastifyReply) => Promise<T> | T;

export const idParams = (req: FastifyRequest): { id: string } => req.params as { id: string };
