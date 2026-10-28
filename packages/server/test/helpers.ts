import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HashEmbeddingProvider, type JsonRequest, type LLMProvider } from '@rag/rag';
import type { SectorDTO } from '@rag/shared';
import { FakeChannel } from '@rag/wa-gateway';
import type { AuthUser } from '../src/auth';
import { createServices, type Services } from '../src/context';
import { MemorySecretStore } from '../src/settings';
import type { Clock } from '../src/util';

export class ManualClock implements Clock {
  constructor(private t = new Date('2026-03-02T12:00:00.000Z').getTime()) {} // segunda-feira
  now() {
    return new Date(this.t);
  }
  advance(ms: number) {
    this.t += ms;
  }
  minutes(n: number) {
    this.advance(n * 60_000);
  }
}

type Handler = (req: JsonRequest) => unknown;

/** LLM roteirizado: cada ferramenta (classificar/responder/resumir) tem um handler substituível. */
export class ScriptedLLM implements LLMProvider {
  calls: JsonRequest[] = [];
  fail = false;
  triage: Handler = (req) => ({
    intent: 'duvida', sectorId: this.defaultSector, wantsHuman: false, sentiment: 'neutral',
    standaloneQuery: req.messages.at(-1)?.content ?? '',
  });
  answer: Handler = () => ({ answer: 'Resposta baseada no contexto.', resolved: true, needsHuman: false, usedContext: [1] });
  summary: Handler = () => ({ summary: 'Cliente com dúvida; IA não resolveu.' });
  defaultSector: string | null = null;

  async completeJson(req: JsonRequest): Promise<unknown> {
    this.calls.push(req);
    if (this.fail) throw new (await import('@rag/rag')).LLMUnavailableError('indisponível');
    if (req.toolName === 'classificar') return this.triage(req);
    if (req.toolName === 'responder') return this.answer(req);
    if (req.toolName === 'resumir') return this.summary(req);
    throw new Error(`ferramenta inesperada ${req.toolName}`);
  }
  count(tool: string) {
    return this.calls.filter((c) => c.toolName === tool).length;
  }
}

export interface Env {
  s: Services;
  channel: FakeChannel;
  llm: ScriptedLLM;
  clock: ManualClock;
  dir: string;
  sectors: { fin: SectorDTO; sup: SectorDTO };
  users: { maria: AuthUser; joao: AuthUser; ana: AuthUser; sup: AuthUser; admin: AuthUser };
  /** Executa jobs vencidos até esvaziar a fila. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

const asAuth = (u: { id: string; name: string; displayName: string; role: AuthUser['role']; sectorId: string | null }): AuthUser => ({
  id: u.id, name: u.name, displayName: u.displayName, role: u.role, sectorId: u.sectorId,
});

export interface BareEnv {
  s: Services;
  channel: FakeChannel;
  llm: ScriptedLLM;
  clock: ManualClock;
  dir: string;
  drain(): Promise<void>;
  close(): Promise<void>;
}

/** Ambiente sem setores nem usuários (para exercitar o assistente de configuração e o login reais). */
export function makeBareEnv(): BareEnv {
  const dir = mkdtempSync(join(tmpdir(), 'rag-srv-'));
  const channel = new FakeChannel();
  const llm = new ScriptedLLM();
  const clock = new ManualClock();
  const s = createServices({ dataDir: dir, channel, llm, embedder: new HashEmbeddingProvider(), clock, secrets: new MemorySecretStore() });
  s.settings.setAi({ debounceSeconds: 0 });
  const drain = async () => {
    let settled = false;
    for (let i = 0; i < 50 && !settled; i++) settled = (await s.jobs.runDue()) === 0;
    if (!settled) throw new Error('A fila de jobs não esvaziou (laço?).');
    // Um job que terminou em FAILED nunca deve passar despercebido nos testes.
    const failed = s.db.prepare(`SELECT type, last_error FROM jobs WHERE status = 'FAILED'`).all() as { type: string; last_error: string }[];
    if (failed.length) throw new Error(`Jobs falharam: ${failed.map((f) => `${f.type}: ${f.last_error}`).join(' | ')}`);
  };
  return {
    s, channel, llm, clock, dir, drain,
    async close() {
      await s.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

export async function makeEnv(): Promise<Env> {
  const { s, channel, llm, clock, dir, drain, close } = makeBareEnv();

  const base = { inactivityMinutes: 30, queueTimeoutMin: null, welcomeMessage: null, closingMessage: null, businessHours: null };
  const fin = s.sectors.create({ name: 'Financeiro', description: 'Boletos, pagamentos, reembolsos e cobranças', ...base });
  const sup = s.sectors.create({ name: 'Suporte Técnico', description: 'Problemas técnicos, senha e acesso ao sistema', ...base });
  llm.defaultSector = fin.id;

  const mk = (name: string, displayName: string, role: AuthUser['role'], sectorId: string | null) =>
    asAuth({ ...s.users.create({ name, displayName, email: `${name}@x.com`, passwordHash: 'x', role, sectorId, active: true }) });
  const users = {
    maria: mk('maria', 'Maria Silva', 'AGENT', fin.id),
    joao: mk('joao', 'João Souza', 'AGENT', fin.id),
    ana: mk('ana', 'Ana Lima', 'AGENT', sup.id),
    sup: mk('chefe', 'Carla Chefe', 'SUPERVISOR', fin.id),
    admin: mk('admin', 'Admin', 'ADMIN', null),
  };

  return { s, channel, llm, clock, dir, sectors: { fin, sup }, users, drain, close };
}

/** Indexa um FAQ e espera ficar pronto. */
export async function addFaq(env: Env, question: string, answer: string, sectorIds: string[] = []) {
  const doc = env.s.knowledge.addFaq(question, answer, sectorIds);
  await env.drain();
  return doc;
}
