import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AnthropicProvider, SqliteVectorStore, TransformersEmbeddingProvider,
  type EmbeddingProvider, type LLMProvider, type VectorStore,
} from '@rag/rag';
import { ServerEvents } from '@rag/shared';
import type { ChannelAdapter } from '@rag/wa-gateway';
import { AiService } from './ai';
import { AuthService } from './auth';
import { EventBus, rooms } from './bus';
import { ConversationService } from './conversations';
import { openDb, type Db } from './db';
import { JobQueue } from './jobs';
import { KnowledgeService } from './knowledge';
import { ContactRepo, ConversationRepo, MessageRepo, SectorRepo, UserRepo } from './repos';
import { FileSecretStore, SECRET_LLM_KEY, SettingsService, type SecretStore } from './settings';
import { systemClock, silentLogger, type Clock, type Logger } from './util';

export interface ServerOptions {
  dataDir: string;
  channel: ChannelAdapter;
  llm?: LLMProvider;
  embedder?: EmbeddingProvider;
  clock?: Clock;
  log?: Logger;
  secrets?: SecretStore;
}

export interface Services {
  db: Db;
  clock: Clock;
  log: Logger;
  bus: EventBus;
  jobs: JobQueue;
  channel: ChannelAdapter;
  secrets: SecretStore;
  settings: SettingsService;
  store: VectorStore;
  sectors: SectorRepo;
  users: UserRepo;
  contacts: ContactRepo;
  convs: ConversationRepo;
  msgs: MessageRepo;
  auth: AuthService;
  conversations: ConversationService;
  ai: AiService;
  knowledge: KnowledgeService;
  filesDir: string;
  /** Inicia fila de jobs, verificação de inatividade e o canal do WhatsApp. */
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createServices(opts: ServerOptions): Services {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? silentLogger;
  const dataDir = opts.dataDir;
  const filesDir = join(dataDir, 'files');
  mkdirSync(filesDir, { recursive: true });

  const db = openDb(join(dataDir, 'app.db'));
  const secrets = opts.secrets ?? new FileSecretStore(dataDir);
  const embedder = opts.embedder ?? new TransformersEmbeddingProvider(undefined, join(dataDir, 'models'));
  let store: VectorStore;
  try {
    store = new SqliteVectorStore(join(dataDir, 'knowledge.db'), embedder);
  } catch (err) {
    db.close();
    throw err;
  }
  const llm =
    opts.llm ?? new AnthropicProvider({ apiKey: () => secrets.get(SECRET_LLM_KEY) ?? process.env.ANTHROPIC_API_KEY ?? null });

  const bus = new EventBus();
  const jobs = new JobQueue(db, clock, log);
  const settings = new SettingsService(db);
  const sectors = new SectorRepo(db);
  const users = new UserRepo(db);
  const contacts = new ContactRepo(db);
  const convs = new ConversationRepo(db, contacts);
  const msgs = new MessageRepo(db);
  const auth = new AuthService(users, secrets, clock);

  const conversations = new ConversationService({
    db, clock, bus, jobs, channel: opts.channel, settings, sectors, users, contacts, convs, msgs, filesDir, log,
  });
  const ai = new AiService({ db, clock, llm, store, settings, sectors, convs, msgs, conversations, log });
  const knowledge = new KnowledgeService({
    db, clock, store, jobs, bus, sectors, msgs, conversations, dir: join(dataDir, 'knowledge-files'), log,
  });

  jobs.register('ai-reply', (p) => ai.run(String(p.conversationId)), 1);
  jobs.register('inactivity-check', async () => void conversations.runInactivityCheck(), 1);

  // Canal → domínio
  const unsubs = [
    opts.channel.onMessage((m) => {
      try {
        conversations.handleInbound(m);
      } catch (err) {
        log.error({ err, waMessageId: m.waMessageId }, 'falha ao processar mensagem recebida');
      }
    }),
    opts.channel.onAck((id, ack) => conversations.onAck(id, ack)),
    opts.channel.onStatus((s) => bus.publish([rooms.admins], ServerEvents.whatsappStatus, s)),
    opts.channel.onQr((qr) => bus.publish([rooms.admins], ServerEvents.whatsappQr, { qr })),
  ];

  let inactivityTimer: NodeJS.Timeout | undefined;
  let purgeTimer: NodeJS.Timeout | undefined;

  return {
    db, clock, log, bus, jobs, channel: opts.channel, secrets, settings, store, sectors, users, contacts, convs, msgs,
    auth, conversations, ai, knowledge, filesDir,
    async start() {
      jobs.start();
      inactivityTimer = setInterval(() => jobs.enqueue('inactivity-check', {}, { dedupeKey: 'inactivity-check' }), 60_000);
      purgeTimer = setInterval(() => jobs.purge(), 6 * 3600_000);
      inactivityTimer.unref?.();
      purgeTimer.unref?.();
      await opts.channel.start().catch((err) => log.error({ err }, 'canal do WhatsApp não iniciou'));
    },
    async close() {
      clearInterval(inactivityTimer);
      clearInterval(purgeTimer);
      unsubs.forEach((u) => u());
      await jobs.stop();
      await opts.channel.stop().catch(() => undefined);
      store.close();
      db.close();
    },
  };
}
