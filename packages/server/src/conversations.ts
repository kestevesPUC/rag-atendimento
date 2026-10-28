import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ServerEvents,
  normalizePhone,
  phoneToWaId,
  signAgentMessage,
  type AiMeta,
  type CloseReason,
  type ConversationDTO,
  type MessageDTO,
  type SenderType,
} from '@rag/shared';
import type { ChannelAdapter, InboundMessage } from '@rag/wa-gateway';
import type { AuthUser } from './auth';
import { EventBus, conversationRooms, rooms } from './bus';
import type { Db } from './db';
import type { JobQueue } from './jobs';
import type { ContactRepo, ConversationRepo, ConvRow, MessageRepo, SectorRepo, UserRepo } from './repos';
import type { SettingsService } from './settings';
import { HttpError, badRequest, conflict, forbidden, iso, newId, notFound, type Clock, type Logger } from './util';

export interface ConversationDeps {
  db: Db;
  clock: Clock;
  bus: EventBus;
  jobs: JobQueue;
  channel: ChannelAdapter;
  settings: SettingsService;
  sectors: SectorRepo;
  users: UserRepo;
  contacts: ContactRepo;
  convs: ConversationRepo;
  msgs: MessageRepo;
  filesDir: string;
  log: Logger;
}

const MEDIA_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm',
  'application/pdf': 'pdf', 'text/plain': 'txt',
};
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;
const SEND_MAX_ATTEMPTS = 5;

/** DDI padrão 55 para números brasileiros informados sem código do país (decisão D-018). */
export const normalizeBrPhone = (raw: string): string => {
  const d = normalizePhone(raw);
  return /^\d{10,11}$/.test(d) ? `55${d}` : d;
};

export class ConversationService {
  constructor(private readonly d: ConversationDeps) {
    d.jobs.register('send-message', (p, job) => this.deliver(String(p.messageId), job.attempts), SEND_MAX_ATTEMPTS);
  }

  private now = () => iso(this.d.clock.now());

  // ---------- Permissões (RN03, RNF06) ----------
  canRead(user: AuthUser, c: Pick<ConvRow, 'sector_id'>): boolean {
    return user.role === 'ADMIN' || (c.sector_id !== null && c.sector_id === user.sectorId);
  }
  /** Ler é do setor; agir exige a conversa livre ou atribuída ao próprio atendente (decisão D-006). */
  canAct(user: AuthUser, c: Pick<ConvRow, 'sector_id' | 'status' | 'assigned_user_id'>): boolean {
    if (user.role === 'ADMIN') return true;
    if (!this.canRead(user, c)) return false;
    if (user.role === 'SUPERVISOR') return true;
    return c.status !== 'HUMAN' || c.assigned_user_id === user.id;
  }

  getForUser(user: AuthUser, id: string): ConvRow {
    const c = this.d.convs.row(id);
    // 404 (e não 403) para conversas de outros setores: não revela que existem.
    if (!c || !this.canRead(user, c)) throw notFound('Conversa');
    return c;
  }

  listForUser(user: AuthUser, status?: ConvRow['status']): ConversationDTO[] {
    if (user.role === 'ADMIN') return this.d.convs.list({ status });
    if (!user.sectorId) return [];
    return this.d.convs.list({ sectorId: user.sectorId, status });
  }

  // ---------- Emissão de eventos ----------
  emitConversation(id: string, event: string = ServerEvents.conversationUpdated, extraRooms: string[] = []): void {
    const dto = this.d.convs.dto(id);
    const row = this.d.convs.row(id);
    if (dto && row) this.d.bus.publish([...conversationRooms(row.sector_id), ...extraRooms], event, dto);
  }
  /** `conversation:assigned` vai só para a sala pessoal do atendente, não para o setor inteiro. */
  private emitAssigned(id: string, userId: string): void {
    const dto = this.d.convs.dto(id);
    if (dto) this.d.bus.publish([rooms.user(userId)], ServerEvents.conversationAssigned, dto);
  }
  private emitMessage(m: MessageDTO, sectorId: string | null, event: string = ServerEvents.messageNew): void {
    this.d.bus.publish(conversationRooms(sectorId), event, m);
  }

  private touch(id: string, extra: Partial<ConvRow> = {}): void {
    this.d.convs.patch(id, { last_interaction_at: this.now(), warned_at: null, ...extra });
  }

  // ---------- Entrada (cliente → sistema) ----------
  private saveMedia(media: NonNullable<InboundMessage['media']>): { path: string; type: string } | null {
    const buf = Buffer.from(media.dataBase64, 'base64');
    if (buf.length > MAX_MEDIA_BYTES) return null;
    const type = media.mimetype.split(';')[0]!.trim().toLowerCase();
    // O nome do arquivo vem do remetente e NUNCA é usado no caminho (evita path traversal).
    const name = `${newId()}.${MEDIA_EXT[type] ?? 'bin'}`;
    mkdirSync(this.d.filesDir, { recursive: true });
    writeFileSync(join(this.d.filesDir, name), buf);
    return { path: name, type };
  }

  handleInbound(m: InboundMessage): { conversationId: string } | null {
    const { convs, msgs, contacts } = this.d;
    if (msgs.existsByWaId(m.waMessageId)) return null; // reentrega do WhatsApp
    const contact = contacts.upsert(m.waId, m.phone, m.name);

    let conv = convs.openForContact(contact.id);
    let created = false;
    if (!conv) {
      const sectors = this.d.sectors.list();
      try {
        conv = convs.create({
          contactId: contact.id,
          sectorId: sectors.length === 1 ? sectors[0]!.id : null,
          assignedUserId: null, origin: 'CUSTOMER', status: 'BOT', at: this.now(),
        });
        created = true;
      } catch {
        conv = convs.openForContact(contact.id); // outra mensagem criou primeiro (índice único parcial)
        if (!conv) throw new HttpError(500, 'Falha ao abrir conversa.');
      }
    }

    const media = m.media ? this.saveMedia(m.media) : null;
    const msg = msgs.insert({
      conversationId: conv.id, senderType: 'CUSTOMER', body: m.body, waMessageId: m.waMessageId,
      mediaPath: media?.path, mediaType: media?.type, at: this.now(),
    });
    this.touch(conv.id);

    if (created) this.emitConversation(conv.id, ServerEvents.conversationCreated);
    else this.emitConversation(conv.id);
    this.emitMessage(msg, conv.sector_id);

    // RN07/RN08: só conversas do cliente em BOT recebem resposta da IA.
    if (conv.origin === 'CUSTOMER' && conv.status === 'BOT') {
      const debounce = this.d.settings.getAi().debounceSeconds;
      this.d.jobs.enqueue('ai-reply', { conversationId: conv.id }, {
        dedupeKey: `ai-reply:${conv.id}`,
        runAt: new Date(this.d.clock.now().getTime() + debounce * 1000),
      });
    }
    return { conversationId: conv.id };
  }

  // ---------- Saída (sistema → cliente) ----------
  /** Grava a mensagem como PENDING e agenda o envio; a assinatura (RN05) é decidida por quem chama. */
  private queueOutbound(conv: ConvRow, o: { senderType: SenderType; userId?: string; body: string; sentBody?: string; meta?: AiMeta }): MessageDTO {
    const msg = this.d.msgs.insert({
      conversationId: conv.id, senderType: o.senderType, senderUserId: o.userId, body: o.body,
      sentBody: o.sentBody ?? o.body, sendStatus: 'PENDING', aiMeta: o.meta, at: this.now(),
    });
    this.emitMessage(msg, conv.sector_id);
    this.d.jobs.enqueue('send-message', { messageId: msg.id });
    return msg;
  }

  private note(conv: ConvRow, text: string): void {
    const msg = this.d.msgs.insert({ conversationId: conv.id, senderType: 'SYSTEM', body: text, aiMeta: { kind: 'note' }, at: this.now() });
    this.emitMessage(msg, conv.sector_id);
  }

  private async deliver(messageId: string, attempt: number): Promise<void> {
    const msg = this.d.msgs.get(messageId);
    if (!msg || msg.sendStatus === 'SENT') return; // idempotente
    const conv = this.d.convs.row(msg.conversationId)!;
    const contact = this.d.contacts.get(conv.contact_id)!;
    const row = this.d.db.prepare(`SELECT sent_body FROM messages WHERE id = ?`).get(messageId) as { sent_body: string | null };
    try {
      const res = await this.d.channel.sendText(contact.waId, row.sent_body ?? msg.body);
      this.d.msgs.setSent(messageId, res.waMessageId);
      this.emitMessage(this.d.msgs.get(messageId)!, conv.sector_id, ServerEvents.messageUpdated);
    } catch (err) {
      if (attempt >= SEND_MAX_ATTEMPTS) {
        this.d.msgs.setFailed(messageId);
        this.emitMessage(this.d.msgs.get(messageId)!, conv.sector_id, ServerEvents.messageUpdated);
      }
      throw err; // a fila tenta de novo com espera crescente
    }
  }

  onAck(waMessageId: string, ack: number): void {
    const id = this.d.msgs.setAck(waMessageId, ack);
    if (!id) return;
    const msg = this.d.msgs.get(id)!;
    const conv = this.d.convs.row(msg.conversationId);
    if (conv) this.d.bus.publish(conversationRooms(conv.sector_id), ServerEvents.messageAck, { id, conversationId: conv.id, ack });
  }

  // ---------- Ações do atendente ----------
  async startActive(user: AuthUser, input: { phone: string; text: string; name?: string }): Promise<ConversationDTO> {
    const phone = normalizeBrPhone(input.phone);
    const contact = this.d.contacts.upsert(phoneToWaId(phone), phone, input.name);
    const existing = this.d.convs.openForContact(contact.id);
    if (existing) {
      const mine = existing.assigned_user_id === user.id;
      throw conflict(mine ? 'Você já tem uma conversa aberta com este contato.' : 'Já existe uma conversa aberta com este contato; assuma-a ou peça a transferência.');
    }
    if (user.role !== 'ADMIN' && !user.sectorId) throw forbidden('Usuário sem setor não pode iniciar conversas.');
    // RN07: origem AGENT + HUMAN; não existe caminho de volta para BOT nesta conversa.
    const conv = this.d.convs.create({
      contactId: contact.id, sectorId: user.sectorId, assignedUserId: user.id, origin: 'AGENT', status: 'HUMAN', at: this.now(),
    });
    this.d.convs.patch(conv.id, { first_response_at: this.now() });
    this.emitConversation(conv.id, ServerEvents.conversationCreated);
    this.queueOutbound(conv, { senderType: 'AGENT', userId: user.id, body: input.text, sentBody: signAgentMessage(user.displayName, input.text) });
    return this.d.convs.dto(conv.id)!;
  }

  async sendByAgent(user: AuthUser, id: string, text: string): Promise<MessageDTO> {
    let conv = this.getForUser(user, id);
    if (conv.status === 'CLOSED') throw conflict('A conversa está encerrada.');
    if (!this.canAct(user, conv)) throw forbidden('Esta conversa está com outro atendente.');

    if (conv.status === 'BOT' || conv.status === 'QUEUED') {
      // RN08: o humano assume e a IA para. Atualização condicional: se outro assumiu primeiro, 409.
      const took = this.d.convs.patchIfStatus(conv.id, conv.status, {
        status: 'HUMAN', assigned_user_id: user.id, ever_human: 1, human_started_at: this.now(),
      });
      if (!took) throw conflict('Outro atendente assumiu esta conversa agora há pouco.');
      conv = this.d.convs.row(id)!;
      this.note(conv, `${user.displayName} assumiu a conversa.`);
      this.emitConversation(id);
    }
    if (!conv.first_response_at) this.d.convs.patch(id, { first_response_at: this.now() });
    this.touch(id);
    // RN05: a assinatura é aplicada aqui, no servidor — o app não consegue forjar o nome.
    const msg = this.queueOutbound(conv, { senderType: 'AGENT', userId: user.id, body: text, sentBody: signAgentMessage(user.displayName, text) });
    this.emitConversation(id);
    return msg;
  }

  claim(user: AuthUser, id: string): ConversationDTO {
    const conv = this.getForUser(user, id); // outro setor → 404
    // Quem chega depois do vencedor vê a conversa já em HUMAN: deve receber 409 (não 403).
    if (conv.status !== 'QUEUED') throw conflict(conv.status === 'HUMAN' ? 'Esta conversa já foi assumida por outro atendente.' : 'Esta conversa não está na fila.');
    // Atualização condicional (doc 02 §6): o primeiro vence; os demais recebem 409.
    const won = this.d.convs.patchIfStatus(id, 'QUEUED', {
      assigned_user_id: user.id, status: 'HUMAN', ever_human: 1, human_started_at: this.now(), last_interaction_at: this.now(), warned_at: null,
    });
    if (!won) throw conflict('Esta conversa já foi assumida por outro atendente.');
    const fresh = this.d.convs.row(id)!;
    this.note(fresh, `${user.displayName} assumiu a conversa.`);
    this.emitAssigned(id, user.id);
    this.emitConversation(id);
    return this.d.convs.dto(id)!;
  }

  transfer(user: AuthUser, id: string, to: { sectorId?: string; userId?: string }): ConversationDTO {
    const conv = this.getForUser(user, id);
    if (conv.status === 'CLOSED') throw conflict('A conversa está encerrada.');
    if (!this.canAct(user, conv) || (user.role === 'AGENT' && conv.status !== 'HUMAN')) throw forbidden();

    const oldSector = conv.sector_id;
    let patch: Partial<ConvRow>;
    let noteText: string;
    if (to.userId) {
      const target = this.d.users.row(to.userId);
      if (!target || !target.active) throw badRequest('Atendente de destino inválido ou inativo.');
      const sectorId = to.sectorId ?? target.sector_id ?? conv.sector_id;
      if (target.role !== 'ADMIN' && target.sector_id !== sectorId) throw badRequest('O atendente de destino não pertence a esse setor.');
      patch = { status: 'HUMAN', assigned_user_id: target.id, sector_id: sectorId, ever_human: 1, human_started_at: conv.human_started_at ?? this.now() };
      noteText = `${user.displayName} transferiu a conversa para ${target.display_name}.`;
    } else {
      const sector = this.d.sectors.get(to.sectorId!);
      if (!sector) throw badRequest('Setor de destino não encontrado.');
      patch = { status: 'QUEUED', assigned_user_id: null, sector_id: sector.id };
      noteText = `${user.displayName} transferiu a conversa para o setor ${sector.name}.`;
    }
    this.d.convs.patch(id, { ...patch, last_interaction_at: this.now(), warned_at: null });
    const fresh = this.d.convs.row(id)!;
    this.note(fresh, noteText);
    // A conversa sai da sala antiga e aparece na nova (doc 02 §5).
    this.emitConversation(id, ServerEvents.conversationUpdated, conversationRooms(oldSector));
    if (patch.assigned_user_id) this.emitAssigned(id, patch.assigned_user_id);
    return this.d.convs.dto(id)!;
  }

  close(user: AuthUser, id: string): ConversationDTO {
    const conv = this.getForUser(user, id);
    if (conv.status === 'CLOSED') throw conflict('A conversa já está encerrada.');
    if (!this.canAct(user, conv)) throw forbidden();
    this.finish(conv, conv.ever_human ? 'RESOLVED_AGENT' : 'MANUAL');
    return this.d.convs.dto(id)!;
  }

  private finish(conv: ConvRow, reason: CloseReason): void {
    this.d.convs.patch(conv.id, { status: 'CLOSED', closed_at: this.now(), close_reason: reason });
    const closing = conv.sector_id ? this.d.sectors.get(conv.sector_id)?.closingMessage : null;
    const fresh = this.d.convs.row(conv.id)!;
    if (closing) this.queueOutbound(fresh, { senderType: 'SYSTEM', body: closing, meta: { kind: 'system' } });
    this.emitConversation(conv.id, ServerEvents.conversationClosed);
  }

  // ---------- Ações da IA (sempre sem assinatura — RN06) ----------
  /** A IA só age se a conversa ainda for do cliente e estiver em BOT; checagem e escrita no mesmo instante. */
  aiSend(id: string, text: string, meta: AiMeta): boolean {
    const conv = this.d.convs.row(id);
    if (!conv || conv.origin !== 'CUSTOMER' || conv.status !== 'BOT') return false;
    this.queueOutbound(conv, { senderType: 'AI', body: text, meta });
    this.touch(id, conv.first_response_at ? {} : { first_response_at: this.now() });
    this.emitConversation(id);
    return true;
  }

  aiPatch(id: string, fields: Partial<ConvRow>): void {
    this.d.convs.patch(id, fields);
  }

  /** Transfere BOT → QUEUED. Retorna false se um humano já assumiu enquanto a IA pensava. */
  aiTransfer(id: string, o: { sectorId: string | null; text: string; summary: string | null; meta: AiMeta }): boolean {
    const conv = this.d.convs.row(id);
    if (!conv || conv.origin !== 'CUSTOMER') return false;
    const ok = this.d.convs.patchIfStatus(id, 'BOT', {
      status: 'QUEUED', sector_id: o.sectorId ?? conv.sector_id, summary: o.summary, last_interaction_at: this.now(), warned_at: null,
    });
    if (!ok) return false;
    const fresh = this.d.convs.row(id)!;
    this.queueOutbound(fresh, { senderType: 'AI', body: o.text, meta: { ...o.meta, kind: 'transfer' } });
    if (!conv.first_response_at) this.d.convs.patch(id, { first_response_at: this.now() });
    const extra = conversationRooms(conv.sector_id);
    this.emitConversation(id, ServerEvents.conversationUpdated, extra);
    return true;
  }

  // ---------- Inatividade (RN09) ----------
  runInactivityCheck(): { closed: number; warned: number } {
    const settings = this.d.settings.getAi();
    const nowMs = this.d.clock.now().getTime();
    const open = this.d.db
      .prepare(
        `SELECT c.id, c.status, c.sector_id, c.last_interaction_at, c.warned_at, c.ever_human,
                s.inactivity_minutes, s.queue_timeout_min
         FROM conversations c LEFT JOIN sectors s ON s.id = c.sector_id WHERE c.status != 'CLOSED'`,
      )
      .all() as { id: string; status: string; sector_id: string | null; last_interaction_at: string; warned_at: string | null; ever_human: number; inactivity_minutes: number | null; queue_timeout_min: number | null }[];

    let closed = 0;
    let warned = 0;
    for (const c of open) {
      // Na fila, o prazo pode ser maior ou nulo (não encerra) para não perder clientes aguardando.
      const timeoutMin = c.status === 'QUEUED' ? c.queue_timeout_min : (c.inactivity_minutes ?? 30);
      if (timeoutMin === null) continue;
      const elapsed = nowMs - new Date(c.last_interaction_at).getTime();
      const limit = timeoutMin * 60_000;
      const row = this.d.convs.row(c.id)!;
      if (elapsed >= limit) {
        const answeredByAi = c.status === 'BOT' && !c.ever_human && this.d.msgs.countBySender(c.id, 'AI') > 0;
        this.finish(row, answeredByAi ? 'RESOLVED_AI' : 'INACTIVITY');
        closed++;
      } else if (settings.inactivityWarning && !c.warned_at && c.status !== 'QUEUED' && elapsed >= limit * 0.8) {
        this.d.convs.patch(c.id, { warned_at: this.now() }); // não altera last_interaction_at
        this.queueOutbound(row, { senderType: 'SYSTEM', body: 'Ainda está por aí? Se não houver resposta, vamos encerrar este atendimento em breve.', meta: { kind: 'system' } });
        warned++;
      }
    }
    return { closed, warned };
  }
}
