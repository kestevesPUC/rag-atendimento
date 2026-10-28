import { normalizeText, type LLMProvider, type SearchHit, type VectorStore } from '@rag/rag';
import type { AiMeta, AiSettings, SectorDTO } from '@rag/shared';
import {
  answerResult, answerSchema, dynamicSystem, stableSystem, summarySchema, toChat, triageResult, triageSchema, triageSystem,
  type Answer, type ContextChunk, type Triage,
} from './ai-prompts';
import type { ConversationService } from './conversations';
import type { Db } from './db';
import { describeHours, isOpen } from './hours';
import type { ConversationRepo, MessageRepo, SectorRepo } from './repos';
import type { SettingsService } from './settings';
import { aiEnabled } from './repos';
import type { Clock, Logger } from './util';

export interface AiDeps {
  db: Db;
  clock: Clock;
  llm: LLMProvider;
  store: VectorStore;
  settings: SettingsService;
  sectors: SectorRepo;
  convs: ConversationRepo;
  msgs: MessageRepo;
  conversations: ConversationService;
  log: Logger;
}

export interface GeneratedAnswer {
  answer: Answer;
  hits: SearchHit[];
  topScore: number;
  belowThreshold: boolean;
  latencyMs: number;
}

const HISTORY = 10;
const MAX_ROUNDS = 3;

export class AiService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly d: AiDeps) {}

  /** Executa o job `ai-reply`. Uma conversa por vez: mensagens seguidas não geram respostas duplicadas. */
  run(conversationId: string): Promise<void> {
    const prev = this.locks.get(conversationId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.process(conversationId));
    this.locks.set(conversationId, next);
    void next.finally(() => this.locks.get(conversationId) === next && this.locks.delete(conversationId)).catch(() => undefined);
    return next;
  }

  private customerCount(id: string): number {
    return (this.d.db.prepare(`SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND sender_type = 'CUSTOMER'`).get(id) as { n: number }).n;
  }

  private async process(id: string): Promise<void> {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const conv = this.d.convs.row(id);
      // RN07/RN08: rechecado aqui porque a conversa pode ter mudado desde que o job foi agendado.
      if (!conv || !aiEnabled(conv)) return;

      const history = this.d.msgs.recent(id, HISTORY);
      let lastBot = -1;
      history.forEach((m, i) => void (m.senderType === 'AI' || m.senderType === 'AGENT' ? (lastBot = i) : 0));
      const pending = history.slice(lastBot + 1).filter((m) => m.senderType === 'CUSTOMER');
      if (!pending.length) return; // já respondido

      const seen = this.customerCount(id);
      const outcome = await this.decide(id, history, pending.map((m) => m.body).join('\n').trim());
      // O cliente escreveu mais enquanto a IA pensava: descarta e refaz com o contexto completo.
      if (this.customerCount(id) !== seen) continue;
      await outcome();
      return;
    }
  }

  /** Decide o que fazer e devolve a ação a executar (separado para poder descartá-la). */
  private async decide(id: string, history: ReturnType<MessageRepo['recent']>, text: string): Promise<() => Promise<void> | void> {
    const conv = this.d.convs.row(id)!;
    const ai = this.d.settings.getAi();
    const sectors = this.d.sectors.list();
    const sectorById = new Map(sectors.map((s) => [s.id, s]));

    if (!text) return () => this.transfer(id, conv.sector_id, 'MEDIA_ONLY', 'Recebi sua mensagem, mas só consigo ler texto por aqui.');

    let triage: Triage;
    try {
      triage = await this.triage(history, sectors, ai);
    } catch (err) {
      return () => this.transfer(id, conv.sector_id, 'LLM_UNAVAILABLE', undefined, err);
    }

    let sectorId = conv.sector_id;
    if (!sectorId && triage.sectorId && sectorById.has(triage.sectorId)) sectorId = triage.sectorId;
    const sector = sectorId ? (sectorById.get(sectorId) ?? null) : null;

    // Transferências imediatas (RN11 b, d, e)
    const lowered = normalizeText(text);
    const keyword = ai.alwaysHumanKeywords.find((k) => lowered.includes(normalizeText(k)));
    if (triage.wantsHuman) return () => this.transfer(id, sectorId, 'CUSTOMER_REQUEST');
    if (triage.sentiment === 'very_negative') return () => this.transfer(id, sectorId, 'NEGATIVE_SENTIMENT');
    if (keyword) return () => this.transfer(id, sectorId, 'ALWAYS_HUMAN_TOPIC');

    // Setor ainda indefinido com várias opções: pergunta (RN04); depois de 2 tentativas, usa o padrão.
    if (!sectorId && sectors.length > 1) {
      if (conv.menu_count < 2) {
        const menu = `Para te direcionar melhor, sobre qual assunto você quer falar?\n${sectors.map((s, i) => `${i + 1} - ${s.name}`).join('\n')}`;
        return () => {
          this.d.conversations.aiSend(id, menu, { kind: 'menu' });
          this.d.conversations.aiPatch(id, { menu_count: conv.menu_count + 1 });
        };
      }
      return () => this.transfer(id, null, 'SECTOR_UNKNOWN');
    }

    const generated = await this.generate(triage.standaloneQuery || text, sector, toChat(history), ai).catch((err: unknown) => err as Error);
    if (generated instanceof Error) return () => this.transfer(id, sectorId, 'LLM_UNAVAILABLE', undefined, generated);

    // RN11 (a): relevância abaixo do limiar. RN12: sem contexto, a IA não responde sozinha.
    if (generated.belowThreshold) return () => this.transfer(id, sectorId, 'LOW_CONFIDENCE', undefined, undefined, generated.topScore);
    if (generated.answer.needsHuman || !generated.answer.answer.trim()) {
      return () => this.transfer(id, sectorId, 'MODEL_NEEDS_HUMAN', undefined, undefined, generated.topScore);
    }

    return async () => {
      if (sectorId && sectorId !== conv.sector_id) this.d.conversations.aiPatch(id, { sector_id: sectorId });
      const welcome = sector?.welcomeMessage;
      if (welcome && this.d.msgs.countBySender(id, 'AI') === 0) this.d.conversations.aiSend(id, welcome, { kind: 'welcome' });

      const used = generated.answer.usedContext.filter((n) => n >= 1 && n <= generated.hits.length);
      const meta: AiMeta = {
        kind: 'answer', model: ai.answerModel, latencyMs: generated.latencyMs, topScore: round(generated.topScore),
        usedChunkIds: used.map((n) => generated.hits[n - 1]!.chunkId),
        sources: generated.hits.map((h) => ({
          chunkId: h.chunkId, title: h.metadata?.title ?? 'Documento', score: round(h.vectorScore), excerpt: h.content.slice(0, 200),
        })),
      };
      if (!this.d.conversations.aiSend(id, generated.answer.answer.trim(), meta)) return;

      // RN11 (c): N respostas consecutivas sem resolução → transfere (D-007).
      const attempts = generated.answer.resolved ? 0 : conv.failed_ai_attempts + 1;
      this.d.conversations.aiPatch(id, { failed_ai_attempts: attempts });
      if (attempts >= ai.maxFailedAttempts) await this.transfer(id, sectorId, 'MAX_ATTEMPTS');
    };
  }

  // ---------- Etapas com LLM ----------
  private async triage(history: ReturnType<MessageRepo['recent']>, sectors: SectorDTO[], ai: AiSettings): Promise<Triage> {
    const raw = await this.d.llm.completeJson({
      model: ai.triageModel, systemStable: triageSystem(sectors), messages: toChat(history),
      toolName: 'classificar', toolDescription: 'Classifica a mensagem do cliente.', schema: triageSchema, maxTokens: 400,
    });
    return triageResult.parse(raw);
  }

  /** Recuperação + geração. Também é usada pelo playground do admin. */
  async generate(query: string, sector: SectorDTO | null, chat: ReturnType<typeof toChat>, ai: AiSettings, allSectors = false): Promise<GeneratedAnswer> {
    const started = this.d.clock.now().getTime();
    const hits = await this.d.store.search(query, { sectorId: sector?.id ?? null, allSectors, limit: 5 });
    const topScore = hits.reduce((m, h) => Math.max(m, h.vectorScore), 0);
    const belowThreshold = !hits.length || topScore < ai.relevanceThreshold;
    if (belowThreshold) {
      return { answer: { answer: '', resolved: false, needsHuman: true, usedContext: [] }, hits, topScore, belowThreshold, latencyMs: 0 };
    }

    const chunks: ContextChunk[] = hits.map((h, i) => ({ position: i + 1, chunkId: h.chunkId, content: h.content }));
    const examples = this.d.db
      .prepare(`SELECT question, answer FROM style_examples WHERE approved = 1 AND (sector_id IS NULL OR sector_id = ?) LIMIT 8`)
      .all(sector?.id ?? null) as { question: string; answer: string }[];
    const raw = await this.d.llm.completeJson({
      model: ai.answerModel, systemStable: stableSystem(ai), systemDynamic: dynamicSystem(sector, chunks, examples),
      messages: chat.length ? chat : [{ role: 'user', content: query }],
      toolName: 'responder', toolDescription: 'Responde ao cliente com base no contexto.', schema: answerSchema, maxTokens: 700,
    });
    const answer = answerResult.parse(raw);
    return { answer, hits, topScore, belowThreshold: false, latencyMs: this.d.clock.now().getTime() - started };
  }

  private async summarize(id: string, ai: AiSettings): Promise<string> {
    const history = this.d.msgs.recent(id, 20);
    try {
      const raw = (await this.d.llm.completeJson({
        model: ai.triageModel, systemStable: 'Resuma a conversa abaixo para um atendente humano que vai assumi-la: o que o cliente quer, o que já foi tentado e o estado atual. Máximo 4 linhas.',
        messages: toChat(history), toolName: 'resumir', toolDescription: 'Resumo da conversa.', schema: summarySchema, maxTokens: 300,
      })) as { summary?: string };
      if (raw.summary?.trim()) return raw.summary.trim();
    } catch {
      /* cai no resumo simples abaixo */
    }
    const lastLines = history.filter((m) => m.senderType === 'CUSTOMER').slice(-3).map((m) => `- ${m.body.slice(0, 160)}`);
    return `Resumo automático indisponível. Últimas mensagens do cliente:\n${lastLines.join('\n')}`;
  }

  // ---------- Transferência (doc 03 §2) ----------
  private async transfer(id: string, sectorId: string | null, reason: string, customText?: string, err?: unknown, topScore?: number): Promise<void> {
    const ai = this.d.settings.getAi();
    const sectors = this.d.sectors.list();
    const target = sectors.find((s) => s.id === sectorId) ?? sectors.find((s) => s.id === ai.defaultSectorId) ?? sectors[0] ?? null;
    if (err) this.d.log.warn({ id, reason, err: err instanceof Error ? err.message : String(err) }, 'IA indisponível; transferindo');

    let text = target ? `Vou te transferir para um atendente do setor ${target.name}. Aguarde um momento.` : 'Vou te transferir para um atendente. Aguarde um momento.';
    if (reason === 'LLM_UNAVAILABLE') text = `Estamos com uma instabilidade no atendimento automático. ${text}`;
    if (customText) text = `${customText} ${text}`;
    // RN13: fora do horário a IA ainda atende, mas avisa quando precisa transferir.
    if (target && !isOpen(target.businessHours, this.d.clock.now())) {
      text += `\nNo momento estamos fora do horário de atendimento do setor (${describeHours(target.businessHours)}). Sua conversa ficou na fila e será atendida assim que possível.`;
    }
    const summary = reason === 'LLM_UNAVAILABLE' ? null : await this.summarize(id, ai);
    const meta: AiMeta = { reason, topScore: topScore === undefined ? undefined : round(topScore) };
    this.d.conversations.aiTransfer(id, { sectorId: target?.id ?? null, text, summary: summary ?? this.fallbackSummary(id), meta });
  }

  private fallbackSummary(id: string): string {
    const last = this.d.msgs.recent(id, 10).filter((m) => m.senderType === 'CUSTOMER').slice(-3).map((m) => `- ${m.body.slice(0, 160)}`);
    return `Resumo automático indisponível. Últimas mensagens do cliente:\n${last.join('\n')}`;
  }
}

const round = (n: number) => Math.round(n * 1000) / 1000;
