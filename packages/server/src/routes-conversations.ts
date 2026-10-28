import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sendMessageSchema, startConversationSchema, transferSchema } from '@rag/shared';
import { idParams, parse, type Routes } from './http';
import { forbidden, notFound } from './util';

const statusQuery = z.object({ status: z.enum(['BOT', 'QUEUED', 'HUMAN', 'CLOSED']).optional() });
const feedbackSchema = z.object({ value: z.union([z.literal(1), z.literal(-1), z.null()]) });
const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', ogg: 'audio/ogg', mp3: 'audio/mpeg',
  m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', pdf: 'application/pdf', txt: 'text/plain',
};

export const conversationRoutes: Routes = (app, s) => {
  const svc = s.conversations;

  app.get('/conversations', async (req) => svc.listForUser(req.user, parse(statusQuery, req.query).status));

  app.post('/conversations', async (req, reply) => reply.code(201).send(await svc.startActive(req.user, parse(startConversationSchema, req.body))));

  app.get('/conversations/:id', async (req) => {
    const c = svc.getForUser(req.user, idParams(req).id);
    return s.convs.dto(c.id);
  });

  app.get('/conversations/:id/messages', async (req) => s.msgs.list(svc.getForUser(req.user, idParams(req).id).id));

  app.post('/conversations/:id/messages', async (req, reply) =>
    reply.code(201).send(await svc.sendByAgent(req.user, idParams(req).id, parse(sendMessageSchema, req.body).text)));

  app.post('/conversations/:id/claim', async (req) => svc.claim(req.user, idParams(req).id));
  app.post('/conversations/:id/transfer', async (req) => svc.transfer(req.user, idParams(req).id, parse(transferSchema, req.body)));
  app.post('/conversations/:id/close', async (req) => svc.close(req.user, idParams(req).id));

  // 👍/👎 em respostas da IA (doc 03 §7)
  app.post('/messages/:id/feedback', async (req) => {
    const msg = s.msgs.get(idParams(req).id);
    if (!msg) throw notFound('Mensagem');
    svc.getForUser(req.user, msg.conversationId); // isolamento por setor
    if (msg.senderType !== 'AI') throw forbidden('Só respostas da IA recebem avaliação.');
    s.msgs.setFeedback(msg.id, parse(feedbackSchema, req.body).value);
    return s.msgs.get(msg.id);
  });

  // Mídia recebida: só quem pode ler a conversa dona do arquivo.
  app.get('/files/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!/^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/.test(name)) throw notFound('Arquivo');
    const owner = s.db.prepare(`SELECT conversation_id FROM messages WHERE media_path = ?`).get(name) as { conversation_id: string } | undefined;
    if (!owner) throw notFound('Arquivo');
    svc.getForUser(req.user, owner.conversation_id);
    const path = join(s.filesDir, name);
    if (!existsSync(path)) throw notFound('Arquivo');
    return reply
      .header('content-type', MIME_BY_EXT[name.split('.').pop()!] ?? 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .send(createReadStream(path));
  });
};
