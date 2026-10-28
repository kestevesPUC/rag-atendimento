import { z } from 'zod';
import { aiSettingsSchema, faqInputSchema, playgroundSchema, urlInputSchema } from '@rag/shared';
import { toChat } from './ai-prompts';
import { idParams, parse, requireRole, type Routes } from './http';
import { MAX_UPLOAD_BYTES } from './knowledge';
import { reportSummary } from './reports';
import { SECRET_LLM_KEY } from './settings';
import { badRequest } from './util';

const sectorIdsSchema = z.object({ sectorIds: z.array(z.string()) });
const fromMessageSchema = z.object({ messageId: z.string(), question: z.string().min(3).max(500).optional(), answer: z.string().min(3).max(4000).optional() });
const apiKeySchema = z.object({ apiKey: z.string().trim().min(20).max(300).nullable() });
const reportQuery = z.object({ from: z.string().optional(), to: z.string().optional(), sectorId: z.string().optional() });

export const adminRoutes: Routes = (app, s) => {
  // Upload binário direto (sem multipart): o nome vem na query e o corpo é o arquivo.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES + 1024 }, (_req, body, done) => done(null, body));

  // ---------- Base de conhecimento ----------
  app.get('/knowledge/documents', async (req) => (requireRole(req.user, 'ADMIN'), s.knowledge.list()));

  app.post('/knowledge/documents/file', async (req, reply) => {
    requireRole(req.user, 'ADMIN');
    const q = parse(z.object({ filename: z.string().min(1).max(200), sectorIds: z.string().optional() }), req.query);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('Envie o arquivo no corpo da requisição (application/octet-stream).');
    const sectorIds = q.sectorIds ? q.sectorIds.split(',').filter(Boolean) : [];
    return reply.code(201).send(s.knowledge.addFile(q.filename, req.body, sectorIds));
  });
  app.post('/knowledge/documents/faq', async (req, reply) => {
    requireRole(req.user, 'ADMIN');
    const b = parse(faqInputSchema, req.body);
    return reply.code(201).send(s.knowledge.addFaq(b.question, b.answer, b.sectorIds));
  });
  app.post('/knowledge/documents/url', async (req, reply) => {
    requireRole(req.user, 'ADMIN');
    const b = parse(urlInputSchema, req.body);
    return reply.code(201).send(s.knowledge.addUrl(b.url, b.sectorIds));
  });
  app.patch('/knowledge/documents/:id', async (req) => (requireRole(req.user, 'ADMIN'), s.knowledge.updateSectors(idParams(req).id, parse(sectorIdsSchema, req.body).sectorIds)));
  app.post('/knowledge/documents/:id/reprocess', async (req) => (requireRole(req.user, 'ADMIN'), s.knowledge.reprocess(idParams(req).id)));
  app.delete('/knowledge/documents/:id', async (req, reply) => {
    requireRole(req.user, 'ADMIN');
    s.knowledge.delete(idParams(req).id);
    return reply.code(204).send();
  });

  // RF18: qualquer atendente pode sugerir uma resposta humana como FAQ do próprio setor.
  app.post('/knowledge/from-message', async (req, reply) => {
    const b = parse(fromMessageSchema, req.body);
    return reply.code(201).send(s.knowledge.addFromMessage(req.user, b.messageId, b));
  });

  // RF17: testar a pergunta e ver resposta + fontes, sem criar conversa.
  app.post('/knowledge/playground', async (req) => {
    requireRole(req.user, 'ADMIN');
    const b = parse(playgroundSchema, req.body);
    const sector = b.sectorId ? s.sectors.get(b.sectorId) : null;
    const ai = s.settings.getAi();
    try {
      const g = await s.ai.generate(b.question, sector, toChat([{ senderType: 'CUSTOMER', body: b.question }]), ai, !sector);
      return {
        threshold: ai.relevanceThreshold, topScore: g.topScore, belowThreshold: g.belowThreshold,
        wouldTransfer: g.belowThreshold || g.answer.needsHuman, answer: g.answer.answer, resolved: g.answer.resolved,
        sources: g.hits.map((h, i) => ({ position: i + 1, chunkId: h.chunkId, title: h.metadata?.title ?? 'Documento', score: h.vectorScore, content: h.content })),
      };
    } catch (e) {
      throw badRequest(`Não foi possível consultar o modelo de IA: ${e instanceof Error ? e.message : 'erro desconhecido'}`);
    }
  });

  // ---------- WhatsApp ----------
  app.get('/whatsapp/status', async (req) => (requireRole(req.user, 'ADMIN', 'SUPERVISOR'), s.channel.getStatus()));
  app.get('/whatsapp/qr', async (req) => (requireRole(req.user, 'ADMIN'), { qr: s.channel.getQr() }));
  app.post('/whatsapp/start', async (req) => {
    requireRole(req.user, 'ADMIN');
    await s.channel.start();
    return s.channel.getStatus();
  });
  app.post('/whatsapp/stop', async (req) => {
    requireRole(req.user, 'ADMIN');
    await s.channel.stop();
    return s.channel.getStatus();
  });

  // ---------- Configurações da IA ----------
  app.get('/settings/ai', async (req) => (requireRole(req.user, 'ADMIN'), { ...s.settings.getAi(), apiKeyConfigured: !!(s.secrets.get(SECRET_LLM_KEY) ?? process.env.ANTHROPIC_API_KEY) }));
  app.put('/settings/ai', async (req) => (requireRole(req.user, 'ADMIN'), s.settings.setAi(parse(aiSettingsSchema.partial(), req.body))));
  // Somente escrita: a chave nunca volta por nenhuma rota (doc 02 §2).
  app.put('/settings/ai-key', async (req) => {
    requireRole(req.user, 'ADMIN');
    s.secrets.set(SECRET_LLM_KEY, parse(apiKeySchema, req.body).apiKey);
    return { apiKeyConfigured: !!s.secrets.get(SECRET_LLM_KEY) };
  });

  // ---------- Relatórios (RF19) ----------
  app.get('/reports/summary', async (req) => {
    requireRole(req.user, 'ADMIN', 'SUPERVISOR');
    const q = parse(reportQuery, req.query);
    // Supervisor vê apenas o próprio setor, independentemente do filtro informado.
    const sectorId = req.user.role === 'SUPERVISOR' ? req.user.sectorId : (q.sectorId ?? null);
    return reportSummary(s.db, { from: q.from, to: q.to, sectorId, now: s.clock.now() });
  });
};
