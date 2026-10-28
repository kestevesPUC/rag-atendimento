import { z } from 'zod';
import { loginSchema, quickReplySchema, refreshSchema, sectorInputSchema, userInputSchema } from '@rag/shared';
import { hashPassword } from './auth';
import { idParams, parse, requireRole, type Routes } from './http';
import { newId, HttpError, badRequest, conflict, notFound } from './util';

const userUpdateSchema = userInputSchema.extend({ password: z.string().min(8).max(128).optional() });
const setupSchema = z.object({ name: z.string().trim().min(2), email: z.string().email(), password: z.string().min(8).max(128) });

const isUniqueViolation = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/.test(e.message);

export const coreRoutes: Routes = (app, s) => {
  // ---------- Público ----------
  app.get('/health', async () => ({ ok: true, whatsapp: s.channel.getStatus().state }));

  // Assistente de primeira execução (doc 02 §7): só funciona enquanto não existe nenhum usuário.
  app.get('/setup/status', async () => ({ needsSetup: s.users.count() === 0 }));
  app.post('/setup', async (req, reply) => {
    if (s.users.count() > 0) throw conflict('A configuração inicial já foi concluída.');
    const b = parse(setupSchema, req.body);
    s.users.create({ name: b.name, displayName: b.name, email: b.email, passwordHash: await hashPassword(b.password), role: 'ADMIN', sectorId: null, active: true });
    return reply.code(201).send(await s.auth.login(b.email, b.password, req.ip));
  });

  app.post('/auth/login', async (req) => {
    const b = parse(loginSchema, req.body);
    return s.auth.login(b.email, b.password, req.ip);
  });
  app.post('/auth/refresh', async (req) => s.auth.refresh(parse(refreshSchema, req.body).refreshToken));

  // ---------- Autenticado ----------
  app.get('/me', async (req) => s.users.list().find((u) => u.id === req.user.id));

  app.get('/sectors', async () => s.sectors.list());
  // Lista mínima para escolher o destino de uma transferência: não expõe e-mail nem papel de ninguém.
  app.get('/directory', async (req) => {
    const q = req.query as { sectorId?: string };
    return s.users.list()
      .filter((u) => u.active && (!q.sectorId || u.sectorId === q.sectorId))
      .map((u) => ({ id: u.id, displayName: u.displayName, sectorId: u.sectorId }));
  });

  // ---------- Administração ----------
  app.post('/sectors', async (req, reply) => {
    requireRole(req.user, 'ADMIN');
    try {
      return reply.code(201).send(s.sectors.create(parse(sectorInputSchema, req.body)));
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Já existe um setor com este nome.');
      throw e;
    }
  });
  app.patch('/sectors/:id', async (req) => {
    requireRole(req.user, 'ADMIN');
    try {
      const updated = s.sectors.update(idParams(req).id, parse(sectorInputSchema, req.body));
      if (!updated) throw notFound('Setor');
      return updated;
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Já existe um setor com este nome.');
      throw e;
    }
  });
  app.delete('/sectors/:id', async (req, reply) => {
    requireRole(req.user, 'ADMIN');
    const { id } = idParams(req);
    if (s.sectors.inUse(id)) throw conflict('O setor tem usuários ou conversas; remova-os ou transfira-os antes de excluir.');
    if (!s.sectors.delete(id)) throw notFound('Setor');
    return reply.code(204).send();
  });

  const checkUserInput = (b: z.infer<typeof userUpdateSchema>) => {
    if (b.role !== 'ADMIN' && !b.sectorId) throw badRequest('Atendentes e supervisores precisam de um setor.');
    if (b.sectorId && !s.sectors.get(b.sectorId)) throw badRequest('Setor inexistente.');
  };
  const activeAdmins = () => s.users.list().filter((u) => u.role === 'ADMIN' && u.active);

  app.get('/users', async (req) => {
    requireRole(req.user, 'ADMIN');
    return s.users.list();
  });
  app.post('/users', async (req, reply) => {
    requireRole(req.user, 'ADMIN');
    const b = parse(userInputSchema, req.body);
    checkUserInput(b);
    try {
      return reply.code(201).send(s.users.create({ ...b, passwordHash: await hashPassword(b.password) }));
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Já existe um usuário com este e-mail.');
      throw e;
    }
  });
  app.patch('/users/:id', async (req) => {
    requireRole(req.user, 'ADMIN');
    const { id } = idParams(req);
    const b = parse(userUpdateSchema, req.body);
    checkUserInput(b);
    const cur = s.users.row(id);
    if (!cur) throw notFound('Usuário');
    // Nunca deixar o sistema sem administrador ativo.
    if (cur.role === 'ADMIN' && (b.role !== 'ADMIN' || !b.active) && activeAdmins().length <= 1) {
      throw conflict('Este é o único administrador ativo.');
    }
    try {
      return s.users.update(id, { ...b, passwordHash: b.password ? await hashPassword(b.password) : undefined });
    } catch (e) {
      if (isUniqueViolation(e)) throw conflict('Já existe um usuário com este e-mail.');
      throw e;
    }
  });
  app.delete('/users/:id', async (req, reply) => {
    requireRole(req.user, 'ADMIN');
    const { id } = idParams(req);
    const cur = s.users.row(id);
    if (!cur) throw notFound('Usuário');
    if (id === req.user.id) throw conflict('Você não pode excluir o próprio usuário.');
    if (cur.role === 'ADMIN' && activeAdmins().length <= 1) throw conflict('Este é o único administrador ativo.');
    if (s.users.hasHistory(id)) throw conflict('O usuário tem histórico de atendimentos; desative-o em vez de excluir.');
    s.users.delete(id);
    return reply.code(204).send();
  });

  // ---------- Respostas rápidas (RF13) ----------
  app.get('/quick-replies', async (req) => {
    const rows = s.db
      .prepare(`SELECT id, sector_id AS sectorId, shortcut, body FROM quick_replies WHERE sector_id IS NULL OR sector_id = ? OR ? = 'ADMIN' ORDER BY shortcut`)
      .all(req.user.sectorId, req.user.role);
    return rows;
  });
  app.post('/quick-replies', async (req, reply) => {
    requireRole(req.user, 'ADMIN', 'SUPERVISOR');
    const b = parse(quickReplySchema, req.body);
    // Supervisor só cria para o próprio setor; global e outros setores são do administrador.
    if (req.user.role === 'SUPERVISOR' && b.sectorId !== req.user.sectorId) throw new HttpError(403, 'Supervisores criam respostas rápidas só para o próprio setor.');
    const id = newId();
    s.db.prepare(`INSERT INTO quick_replies(id, sector_id, shortcut, body) VALUES (?,?,?,?)`).run(id, b.sectorId, b.shortcut.toLowerCase(), b.body);
    return reply.code(201).send({ id, ...b, shortcut: b.shortcut.toLowerCase() });
  });
  app.delete('/quick-replies/:id', async (req, reply) => {
    requireRole(req.user, 'ADMIN', 'SUPERVISOR');
    const row = s.db.prepare(`SELECT sector_id FROM quick_replies WHERE id = ?`).get(idParams(req).id) as { sector_id: string | null } | undefined;
    if (!row) throw notFound('Resposta rápida');
    if (req.user.role === 'SUPERVISOR' && row.sector_id !== req.user.sectorId) throw new HttpError(403, 'Sem permissão para esta resposta rápida.');
    s.db.prepare(`DELETE FROM quick_replies WHERE id = ?`).run(idParams(req).id);
    return reply.code(204).send();
  });
};
