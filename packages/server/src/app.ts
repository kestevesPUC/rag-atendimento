import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Services } from './context';
import { HttpError } from './util';
import { adminRoutes } from './routes-admin';
import { conversationRoutes } from './routes-conversations';
import { coreRoutes } from './routes-core';

/** Rotas que não exigem token. */
const PUBLIC = new Set(['/health', '/setup/status', '/setup', '/auth/login', '/auth/refresh']);

export async function buildApp(s: Services, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 * 1024, trustProxy: false });

  // A autenticação é por token Bearer (nunca cookie), então CORS aberto não permite CSRF.
  await app.register(cors, { origin: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('cache-control', 'no-store');
  });

  app.addHook('onRequest', async (req) => {
    if (req.method === 'OPTIONS') return;
    const path = req.url.split('?')[0]!;
    if (PUBLIC.has(path)) return;
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'Autenticação necessária.', 'UNAUTHENTICATED');
    req.user = s.auth.authenticate(header.slice(7));
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Dados inválidos.', code: 'VALIDATION', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message ?? 'Requisição inválida.', code: 'BAD_REQUEST' });
    s.log.error({ err, url: req.url }, 'erro não tratado');
    return reply.code(500).send({ error: 'Erro interno do servidor.', code: 'INTERNAL' });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'Rota não encontrada.', code: 'NOT_FOUND' }));

  coreRoutes(app, s);
  conversationRoutes(app, s);
  adminRoutes(app, s);
  return app;
}
