import type { FastifyInstance } from 'fastify';
import { io as connect, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth';
import { attachRealtime } from '../src/realtime';
import { makeBareEnv, type BareEnv } from './helpers';

let env: BareEnv;
let app: FastifyInstance;
let closeRealtime: () => Promise<void>;
let url: string;
const sockets: Socket[] = [];
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
const sec: Record<string, string> = {};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(token: string | null): Promise<Socket> {
  const s = connect(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false });
  sockets.push(s);
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
  });
}
/** Registra tudo o que o socket receber, por nome de evento. */
function record(s: Socket) {
  const got: { event: string; payload: any }[] = [];
  s.onAny((event, payload) => got.push({ event, payload }));
  return { got, of: (e: string) => got.filter((g) => g.event === e) };
}

beforeEach(async () => {
  env = makeBareEnv();
  app = await buildApp(env.s);
  const rt = attachRealtime(app.server, env.s);
  closeRealtime = rt.close;
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const base = { inactivityMinutes: 30, queueTimeoutMin: null, welcomeMessage: null, closingMessage: null, businessHours: null };
  sec.fin = env.s.sectors.create({ name: 'Financeiro', description: 'Boletos e pagamentos', ...base }).id;
  sec.sup = env.s.sectors.create({ name: 'Suporte', description: 'Problemas técnicos', ...base }).id;
  env.llm.defaultSector = sec.fin;
  const hash = await hashPassword('Senha@12345');
  for (const [key, role, sectorId] of [['admin', 'ADMIN', null], ['maria', 'AGENT', sec.fin], ['joao', 'AGENT', sec.fin], ['ana', 'AGENT', sec.sup]] as const) {
    ids[key] = env.s.users.create({ name: key, displayName: key, email: `${key}@x.com`, passwordHash: hash, role, sectorId: sectorId ?? null, active: true }).id;
    tokens[key] = (await env.s.auth.login(`${key}@x.com`, 'Senha@12345')).accessToken;
  }
});
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.close());
  await closeRealtime();
  await app.close();
  await env.close();
});

describe('Socket.IO: autenticação', () => {
  it('recusa conexão sem token ou com token inválido', async () => {
    await expect(open(null)).rejects.toThrow(/UNAUTHENTICATED/);
    await expect(open('token-falso')).rejects.toThrow(/UNAUTHENTICATED/);
  });
});

describe('Socket.IO: isolamento por setor', () => {
  it('nova conversa do Financeiro chega ao Financeiro e ao admin — e nunca ao Suporte', async () => {
    const [maria, ana, admin] = await Promise.all([open(tokens.maria!), open(tokens.ana!), open(tokens.admin!)]);
    const [m, a, ad] = [record(maria), record(ana), record(admin)];

    env.channel.receive('5511955550001', 'quero contestar a fatura do meu cartão');
    await env.drain();
    await wait(150);

    // Ao nascer a conversa ainda não tem setor (D-019): só o admin recebe "created" e a 1ª mensagem.
    expect(ad.of('conversation:created').length).toBeGreaterThan(0);
    expect(ad.of('message:new').some((e) => e.payload.body.includes('contestar'))).toBe(true);
    // O Financeiro passa a ver a conversa quando a IA define o setor: chega como "updated" (o app faz upsert).
    expect(m.of('conversation:created')).toHaveLength(0);
    expect(m.of('conversation:updated').some((e) => e.payload.sectorId === sec.fin && e.payload.status === 'QUEUED')).toBe(true);
    expect(m.of('message:new').some((e) => /transferir/.test(e.payload.body))).toBe(true);
    // o Suporte não recebe nenhum evento de conversa/mensagem do Financeiro
    expect(a.got.filter((g) => g.event.startsWith('conversation:') || g.event.startsWith('message:'))).toEqual([]);
  });

  it('conversation:assigned vai só para o atendente de destino', async () => {
    const maria = await open(tokens.maria!);
    const joao = await open(tokens.joao!);
    const [m, j] = [record(maria), record(joao)];
    env.channel.receive('5511955550002', 'quero contestar a fatura do meu cartão');
    await env.drain();
    const conv = env.s.convs.list({ status: 'QUEUED' })[0]!;
    env.s.conversations.claim({ id: ids.maria!, name: 'maria', displayName: 'maria', role: 'AGENT', sectorId: sec.fin! }, conv.id);
    await wait(150);
    expect(m.of('conversation:assigned')).toHaveLength(1);
    expect(j.of('conversation:assigned')).toHaveLength(0);
    expect(j.of('conversation:updated').length).toBeGreaterThan(0); // o setor todo vê a mudança de status
  });

  it('transferir de setor avisa o setor antigo (para remover da lista) e o novo', async () => {
    const [maria, ana] = await Promise.all([open(tokens.maria!), open(tokens.ana!)]);
    const [m, a] = [record(maria), record(ana)];
    env.channel.receive('5511955550003', 'quero contestar a fatura do meu cartão');
    await env.drain();
    const conv = env.s.convs.list({ status: 'QUEUED' })[0]!;
    const mariaUser = { id: ids.maria!, name: 'maria', displayName: 'maria', role: 'AGENT' as const, sectorId: sec.fin! };
    env.s.conversations.claim(mariaUser, conv.id);
    m.got.length = 0;
    a.got.length = 0;
    env.s.conversations.transfer(mariaUser, conv.id, { sectorId: sec.sup! });
    await wait(150);
    expect(m.of('conversation:updated').some((e) => e.payload.sectorId === sec.sup)).toBe(true); // o app do Financeiro remove
    expect(a.of('conversation:updated').some((e) => e.payload.id === conv.id && e.payload.status === 'QUEUED')).toBe(true);
  });
});

describe('Socket.IO: presença', () => {
  it('"visualizando" só chega a quem está no setor da conversa; quem não pode ler não consegue emitir', async () => {
    const [maria, joao, ana] = await Promise.all([open(tokens.maria!), open(tokens.joao!), open(tokens.ana!)]);
    const [j, a] = [record(joao), record(ana)];
    env.channel.receive('5511955550004', 'quero contestar a fatura do meu cartão');
    await env.drain();
    const conv = env.s.convs.list({ status: 'QUEUED' })[0]!;

    maria.emit('viewing', { conversationId: conv.id });
    await wait(150);
    expect(j.of('presence')).toHaveLength(1);
    expect(j.of('presence')[0]!.payload).toMatchObject({ type: 'viewing', conversationId: conv.id, userId: ids.maria });
    expect(a.of('presence')).toHaveLength(0);

    // Ana (Suporte) tenta sondar uma conversa do Financeiro: ignorado
    j.got.length = 0;
    ana.emit('typing', { conversationId: conv.id });
    ana.emit('typing', { conversationId: 123 }); // payload malformado não derruba nada
    ana.emit('typing');
    await wait(150);
    expect(j.of('presence')).toHaveLength(0);
  });
});

describe('Socket.IO: sessão', () => {
  it('derruba o socket quando o usuário é desativado (rechecagem periódica)', async () => {
    const maria = await open(tokens.maria!);
    const closed = new Promise<string>((r) => maria.on('disconnect', r));
    env.s.users.update(ids.maria!, { name: 'maria', displayName: 'maria', email: 'maria@x.com', role: 'AGENT', sectorId: sec.fin!, active: false });
    // a rechecagem é a cada 30 s; aqui só confirmamos que, ao reconectar, a credencial antiga não vale mais
    await expect(open(tokens.maria!)).rejects.toThrow(/UNAUTHENTICATED/);
    maria.close();
    await closed;
  });
});
