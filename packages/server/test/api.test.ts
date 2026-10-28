import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { makeBareEnv, type BareEnv } from './helpers';

const PASS = 'Senha@12345';
const PHONE = '5511977776666';

let env: BareEnv;
let app: FastifyInstance;
const tok: Record<string, string> = {};
const id: Record<string, string> = {};
const sec: Record<string, string> = {};

async function call(method: string, url: string, token?: string | null, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: method as 'GET', url, payload: body as object | undefined,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  let json: any = null;
  try { json = res.json(); } catch { /* corpo não-JSON */ }
  return { status: res.statusCode, json, raw: res };
}

async function customerSays(text: string, phone = PHONE, extra = {}) {
  env.channel.receive(phone, text, extra);
  await env.drain();
  const conv = (await call('GET', '/conversations', tok.admin)).json.find((c: any) => c.contact.phone === phone);
  return conv as { id: string; status: string; sectorId: string };
}

beforeEach(async () => {
  env = makeBareEnv();
  app = await buildApp(env.s);
  const setup = await call('POST', '/setup', null, { name: 'Admin', email: 'admin@empresa.com', password: PASS });
  tok.admin = setup.json.accessToken;
  const mkSector = async (name: string, description: string) =>
    (await call('POST', '/sectors', tok.admin, { name, description })).json.id as string;
  sec.fin = await mkSector('Financeiro', 'Boletos, pagamentos e reembolsos');
  sec.sup = await mkSector('Suporte', 'Problemas técnicos e acesso');
  env.llm.defaultSector = sec.fin;
  const mkUser = async (key: string, displayName: string, role: string, sectorId: string) => {
    const r = await call('POST', '/users', tok.admin, { name: displayName, displayName, email: `${key}@empresa.com`, password: PASS, role, sectorId });
    id[key] = r.json.id;
    tok[key] = (await call('POST', '/auth/login', null, { email: `${key}@empresa.com`, password: PASS })).json.accessToken;
  };
  await mkUser('maria', 'Maria Silva', 'AGENT', sec.fin);
  await mkUser('joao', 'João Souza', 'AGENT', sec.fin);
  await mkUser('ana', 'Ana Lima', 'AGENT', sec.sup);
  await mkUser('chefe', 'Carla Chefe', 'SUPERVISOR', sec.fin);
});
afterEach(async () => {
  await app.close();
  await env.close();
});

describe('configuração inicial e autenticação', () => {
  it('o assistente só funciona uma vez', async () => {
    expect((await call('GET', '/setup/status')).json).toEqual({ needsSetup: false });
    expect((await call('POST', '/setup', null, { name: 'X', email: 'x@x.com', password: PASS })).status).toBe(409);
  });

  it('exige token nas rotas protegidas e rejeita tokens inválidos', async () => {
    expect((await call('GET', '/conversations')).status).toBe(401);
    expect((await call('GET', '/conversations', 'lixo')).status).toBe(401);
    expect((await call('GET', '/health')).status).toBe(200);
  });

  it('senha errada → 401 genérico; 5 falhas bloqueiam por um tempo (429)', async () => {
    const bad = () => call('POST', '/auth/login', null, { email: 'maria@empresa.com', password: 'errada' });
    const first = await bad();
    expect(first.status).toBe(401);
    expect(first.json.error).toBe((await call('POST', '/auth/login', null, { email: 'naoexiste@x.com', password: 'x' })).json.error); // sem enumeração
    for (let i = 0; i < 3; i++) await bad();
    expect((await bad()).status).toBe(401); // 5ª falha
    expect((await bad()).status).toBe(429);
    expect((await call('POST', '/auth/login', null, { email: 'maria@empresa.com', password: PASS })).status).toBe(429); // mesmo com a senha certa
    env.clock.minutes(11);
    expect((await call('POST', '/auth/login', null, { email: 'maria@empresa.com', password: PASS })).status).toBe(200);
  });

  it('refresh renova o acesso; token de acesso não serve como refresh', async () => {
    const login = (await call('POST', '/auth/login', null, { email: 'maria@empresa.com', password: PASS })).json;
    expect((await call('POST', '/auth/refresh', null, { refreshToken: login.refreshToken })).status).toBe(200);
    expect((await call('POST', '/auth/refresh', null, { refreshToken: login.accessToken })).status).toBe(401);
  });

  it('usuário desativado perde o acesso na hora, sem esperar o token expirar', async () => {
    expect((await call('GET', '/conversations', tok.maria)).status).toBe(200);
    const r = await call('PATCH', `/users/${id.maria}`, tok.admin, { name: 'Maria', displayName: 'Maria Silva', email: 'maria@empresa.com', role: 'AGENT', sectorId: sec.fin, active: false });
    expect(r.status).toBe(200);
    expect((await call('GET', '/conversations', tok.maria)).status).toBe(401);
  });

  it('mudar o setor de um atendente vale imediatamente (o token antigo é revogado)', async () => {
    await call('PATCH', `/users/${id.maria}`, tok.admin, { name: 'Maria', displayName: 'Maria Silva', email: 'maria@empresa.com', role: 'AGENT', sectorId: sec.sup, active: true });
    expect((await call('GET', '/conversations', tok.maria)).status).toBe(401);
  });
});

describe('permissões por papel', () => {
  it('atendente não administra setores, usuários, base, IA nem relatórios', async () => {
    for (const [m, u] of [['POST', '/sectors'], ['GET', '/users'], ['POST', '/users'], ['GET', '/knowledge/documents'], ['POST', '/knowledge/playground'], ['GET', '/settings/ai'], ['PUT', '/settings/ai-key'], ['GET', '/reports/summary'], ['GET', '/whatsapp/qr'], ['POST', '/whatsapp/start']] as const) {
      const r = await call(m, u, tok.maria, {});
      expect(r.status, `${m} ${u}`).toBe(403);
    }
  });

  it('a chave da API de IA é só de escrita: nunca volta nas respostas', async () => {
    const KEY = 'sk-ant-chave-secreta-muito-longa-123456';
    expect((await call('GET', '/settings/ai', tok.admin)).json.apiKeyConfigured).toBe(false);
    const put = await call('PUT', '/settings/ai-key', tok.admin, { apiKey: KEY });
    expect(put.json).toEqual({ apiKeyConfigured: true });
    const get = await call('GET', '/settings/ai', tok.admin);
    expect(get.json.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(get.json)).not.toContain(KEY);
    expect(JSON.stringify(put.json)).not.toContain(KEY);
  });

  it('não é possível remover ou desativar o único administrador', async () => {
    const admin = (await call('GET', '/me', tok.admin)).json;
    expect((await call('DELETE', `/users/${admin.id}`, tok.admin)).status).toBe(409);
    const r = await call('PATCH', `/users/${admin.id}`, tok.admin, { name: 'Admin', displayName: 'Admin', email: 'admin@empresa.com', role: 'ADMIN', sectorId: null, active: false });
    expect(r.status).toBe(409);
  });

  it('valida entradas: e-mail duplicado (409), atendente sem setor (400), telefone inválido (400)', async () => {
    const base = { name: 'Fulano', displayName: 'Fulano', password: PASS, role: 'AGENT' };
    expect((await call('POST', '/users', tok.admin, { ...base, email: 'maria@empresa.com', sectorId: sec.fin })).status).toBe(409);
    expect((await call('POST', '/users', tok.admin, { ...base, email: 'novo@empresa.com', sectorId: null })).status).toBe(400);
    const bad = await call('POST', '/conversations', tok.maria, { phone: '123', text: 'oi' });
    expect(bad.status).toBe(400);
    expect(bad.json.issues[0].path).toBe('phone');
  });

  it('supervisor vê o relatório só do próprio setor, mesmo pedindo outro', async () => {
    await customerSays('quero contestar a fatura do meu cartão'); // setor Financeiro
    env.channel.receive('5511900000001', 'ajuda');
    env.llm.defaultSector = sec.sup ?? null;
    await env.drain();
    const own = (await call('GET', `/reports/summary?sectorId=${sec.sup}`, tok.chefe)).json;
    expect(own.bySector.every((s: any) => s.sectorId === sec.fin)).toBe(true);
    const all = (await call('GET', '/reports/summary', tok.admin)).json;
    expect(all.totals.conversations).toBeGreaterThanOrEqual(own.totals.conversations);
  });
});

describe('critérios de aceite do MVP (doc 04 §6) — via API', () => {
  it('1. atendente do setor A não lista, lê nem envia em conversas do setor B', async () => {
    const conv = await customerSays('quero contestar a fatura do meu cartão'); // Financeiro
    expect(conv.sectorId).toBe(sec.fin);

    expect((await call('GET', '/conversations', tok.ana)).json).toEqual([]);
    const probes: [string, string, unknown?][] = [
      ['GET', `/conversations/${conv.id}`], ['GET', `/conversations/${conv.id}/messages`],
      ['POST', `/conversations/${conv.id}/messages`, { text: 'invasão' }], ['POST', `/conversations/${conv.id}/claim`],
      ['POST', `/conversations/${conv.id}/transfer`, { sectorId: sec.sup }], ['POST', `/conversations/${conv.id}/close`],
    ];
    for (const [m, u, b] of probes) expect((await call(m, u, tok.ana, b)).status, `${m} ${u}`).toBe(404);

    const msgId = (await call('GET', `/conversations/${conv.id}/messages`, tok.maria)).json[0].id;
    expect((await call('POST', `/messages/${msgId}/feedback`, tok.ana, { value: 1 })).status).toBe(404);
    expect((await call('POST', '/knowledge/from-message', tok.ana, { messageId: msgId })).status).toBe(404);
    expect(env.channel.sent.some((s) => s.text.includes('invasão'))).toBe(false);

    // a conversa continua intacta e acessível ao setor certo
    expect((await call('GET', `/conversations/${conv.id}`, tok.maria)).status).toBe(200);
    expect((await call('GET', `/conversations/${conv.id}`, tok.admin)).status).toBe(200);
  });

  it('2. mensagem do app chega ao WhatsApp como "*Nome*\\ntexto"; o cliente do app não consegue forjar o nome', async () => {
    const conv = await customerSays('quero contestar a fatura do meu cartão');
    const r = await call('POST', `/conversations/${conv.id}/messages`, tok.maria, { text: 'Olá, sou eu.', displayName: 'Diretor', senderName: 'Diretor', sentBody: 'x' });
    expect(r.status).toBe(201);
    await env.drain();
    expect(env.channel.sent.at(-1)!.text).toBe('*Maria Silva*\nOlá, sou eu.');
    expect(r.json.body).toBe('Olá, sou eu.');
    expect(r.json.senderName).toBe('Maria Silva');
    // a mensagem automática da IA saiu sem assinatura
    expect(env.channel.sent.find((s) => /transferir/.test(s.text))!.text).not.toMatch(/^\*/);
  });

  it('3. conversa iniciada pelo atendente nunca recebe resposta da IA, mesmo se o cliente responder', async () => {
    const r = await call('POST', '/conversations', tok.maria, { phone: '(11) 97777-6666', text: 'Bom dia!' });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ origin: 'AGENT', status: 'HUMAN', aiEnabled: false });
    await env.drain();
    env.channel.receive(PHONE, 'oi, quem é?');
    env.channel.receive(PHONE, 'alô?');
    await env.drain();
    expect(env.llm.calls).toHaveLength(0);
    const msgs = (await call('GET', `/conversations/${r.json.id}/messages`, tok.maria)).json;
    expect(msgs.filter((m: any) => m.senderType === 'AI')).toHaveLength(0);
  });

  it('4. sem interação pelo tempo do setor a conversa encerra; a nova mensagem abre outra conversa com a IA', async () => {
    const conv = await customerSays('quero contestar a fatura do meu cartão');
    await call('POST', `/conversations/${conv.id}/claim`, tok.maria);
    env.clock.minutes(31);
    expect(env.s.conversations.runInactivityCheck().closed).toBe(1);
    expect((await call('GET', `/conversations/${conv.id}`, tok.maria)).json).toMatchObject({ status: 'CLOSED', closeReason: 'INACTIVITY' });

    const next = await customerSays('voltei');
    expect(next.id).not.toBe(conv.id);
    expect((await call('GET', `/conversations/${next.id}`, tok.admin)).json).toMatchObject({ origin: 'CUSTOMER' });
    expect(env.llm.count('classificar')).toBeGreaterThan(1);
  });

  it('5. pergunta fora da base → transferência para a fila do setor certo, com resumo', async () => {
    const conv = await customerSays('quero contestar a fatura do meu cartão');
    const dto = (await call('GET', `/conversations/${conv.id}`, tok.maria)).json;
    expect(dto).toMatchObject({ status: 'QUEUED', sectorId: sec.fin });
    expect(dto.summary).toBeTruthy();
    expect((await call('GET', '/conversations?status=QUEUED', tok.maria)).json.map((c: any) => c.id)).toContain(conv.id);
  });

  it('6. dois atendentes assumindo ao mesmo tempo: só um assume, o outro recebe 409', async () => {
    const conv = await customerSays('quero contestar a fatura do meu cartão');
    const [a, b] = await Promise.all([
      call('POST', `/conversations/${conv.id}/claim`, tok.maria),
      call('POST', `/conversations/${conv.id}/claim`, tok.joao),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? id.maria : id.joao;
    expect((await call('GET', `/conversations/${conv.id}`, tok.admin)).json.assignedUserId).toBe(winner);
  });
});

describe('base de conhecimento pela API', () => {
  it('upload → processamento → READY; playground mostra fontes; excluir remove da busca', async () => {
    const text = 'Política de trocas\n\nAceitamos trocas em até 30 dias após a compra, mediante nota fiscal e produto sem uso.';
    const up = await call('POST', `/knowledge/documents/file?filename=${encodeURIComponent('trocas.txt')}&sectorIds=${sec.fin}`, tok.admin, Buffer.from(text), { 'content-type': 'application/octet-stream' });
    expect(up.status).toBe(201);
    expect(up.json).toMatchObject({ status: 'PENDING', type: 'txt', title: 'trocas', sectorIds: [sec.fin] });
    await env.drain();
    const docs = (await call('GET', '/knowledge/documents', tok.admin)).json;
    expect(docs[0]).toMatchObject({ status: 'READY', chunkCount: 1 });

    const pg = await call('POST', '/knowledge/playground', tok.admin, { question: 'trocas em até 30 dias após a compra', sectorId: sec.fin });
    expect(pg.json.belowThreshold).toBe(false);
    expect(pg.json.sources[0].content).toContain('30 dias');
    expect(pg.json.answer).toBeTruthy();
    // setor errado não enxerga o documento do Financeiro
    const other = await call('POST', '/knowledge/playground', tok.admin, { question: 'trocas em até 30 dias após a compra', sectorId: sec.sup });
    expect(other.json.wouldTransfer).toBe(true);

    expect((await call('DELETE', `/knowledge/documents/${docs[0].id}`, tok.admin)).status).toBe(204);
    expect(env.s.store.countChunks()).toBe(0);
  });

  it('rejeita formato não suportado, setor inexistente e URL interna (falha na ingestão com motivo)', async () => {
    const bin = { 'content-type': 'application/octet-stream' };
    expect((await call('POST', '/knowledge/documents/file?filename=virus.exe', tok.admin, Buffer.from('x'), bin)).status).toBe(400);
    expect((await call('POST', '/knowledge/documents/file?filename=a.txt&sectorIds=nao-existe', tok.admin, Buffer.from('conteudo'), bin)).status).toBe(400);
    expect((await call('POST', '/knowledge/documents/file?filename=a.txt', tok.admin, undefined, bin)).status).toBe(400);

    const url = await call('POST', '/knowledge/documents/url', tok.admin, { url: 'http://169.254.169.254/latest/meta-data' });
    expect(url.status).toBe(201);
    await env.drain();
    const doc = (await call('GET', '/knowledge/documents', tok.admin)).json.find((d: any) => d.type === 'url');
    expect(doc).toMatchObject({ status: 'FAILED' });
    expect(doc.error).toMatch(/interno/);
  });

  it('RF18: resposta humana vira FAQ do setor da conversa e passa a ser usada pela IA', async () => {
    const conv = await customerSays('qual o prazo de reembolso do boleto?');
    await call('POST', `/conversations/${conv.id}/claim`, tok.maria);
    const sent = await call('POST', `/conversations/${conv.id}/messages`, tok.maria, { text: 'O reembolso do boleto leva 5 dias úteis.' });
    const faq = await call('POST', '/knowledge/from-message', tok.maria, { messageId: sent.json.id });
    expect(faq.status).toBe(201);
    expect(faq.json).toMatchObject({ type: 'faq', sectorIds: [sec.fin] });
    await env.drain();
    expect((await call('GET', '/knowledge/documents', tok.admin)).json[0].status).toBe('READY');
    // só mensagens de atendentes podem virar FAQ
    const cust = (await call('GET', `/conversations/${conv.id}/messages`, tok.maria)).json.find((m: any) => m.senderType === 'CUSTOMER');
    expect((await call('POST', '/knowledge/from-message', tok.maria, { messageId: cust.id })).status).toBe(400);
  });
});

describe('mídia, feedback e relatórios', () => {
  it('arquivos recebidos só abrem para quem pode ler a conversa; nomes maliciosos dão 404', async () => {
    const conv = await customerSays('', PHONE, { media: { mimetype: 'image/png', dataBase64: Buffer.from('PNGDATA').toString('base64') } });
    const msgs = (await call('GET', `/conversations/${conv.id}/messages`, tok.admin)).json;
    const url = msgs.find((m: any) => m.mediaUrl).mediaUrl as string;
    const ok = await call('GET', url, tok.maria);
    expect(ok.status).toBe(200);
    expect(ok.raw.headers['content-type']).toBe('image/png');
    expect(ok.raw.rawPayload.toString()).toBe('PNGDATA');
    expect((await call('GET', url, tok.ana)).status).toBe(404);
    expect((await call('GET', url)).status).toBe(401);
    for (const bad of ['/files/..%2Fapp.db', '/files/app.db', '/files/..%5C..%5Cmaster.key']) expect((await call('GET', bad, tok.admin)).status, bad).toBe(404);
  });

  it('feedback 👍/👎 só em mensagens da IA', async () => {
    await call('PUT', '/settings/ai', tok.admin, { relevanceThreshold: 0.2 });
    await call('POST', '/knowledge/documents/faq', tok.admin, { question: 'Qual o prazo de entrega?', answer: 'Cinco dias úteis.', sectorIds: [] });
    await env.drain();
    const conv = await customerSays('qual o prazo de entrega?');
    const msgs = (await call('GET', `/conversations/${conv.id}/messages`, tok.maria)).json;
    const ai = msgs.find((m: any) => m.senderType === 'AI');
    expect((await call('POST', `/messages/${ai.id}/feedback`, tok.maria, { value: -1 })).json.feedback).toBe(-1);
    const customer = msgs.find((m: any) => m.senderType === 'CUSTOMER');
    expect((await call('POST', `/messages/${customer.id}/feedback`, tok.maria, { value: 1 })).status).toBe(403);
    expect((await call('GET', '/reports/summary', tok.admin)).json.feedback).toEqual({ up: 0, down: 1 });
  });

  it('relatório: totais, taxa de resolução pela IA, transferências e lacunas da base', async () => {
    await call('POST', '/knowledge/documents/faq', tok.admin, { question: 'Qual o prazo de entrega?', answer: 'Cinco dias úteis.', sectorIds: [] });
    await env.drain();
    const answered = await customerSays('qual o prazo de entrega?', '5511911110001');
    const gap = await customerSays('quero contestar a fatura do meu cartão', '5511911110002');
    env.clock.minutes(31);
    env.s.conversations.runInactivityCheck(); // a respondida pela IA encerra como RESOLVED_AI
    const rep = (await call('GET', '/reports/summary', tok.admin)).json;
    expect(rep.totals.conversations).toBe(2);
    expect(rep.aiResolutionRate).toBe(1); // 1 encerrada, sem humano
    expect(rep.transfers).toBe(1);
    expect(rep.gaps.map((g: any) => g.question)).toEqual(['quero contestar a fatura do meu cartão']);
    expect(rep.avgFirstResponseSeconds).not.toBeNull();
    expect((await call('GET', `/conversations/${answered.id}`, tok.admin)).json.closeReason).toBe('RESOLVED_AI');
    expect(gap.status).toBe('QUEUED');
  });
});
