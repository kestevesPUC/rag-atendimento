import type {
  AiMeta,
  BusinessHours,
  CloseReason,
  ContactDTO,
  ConversationDTO,
  ConvOrigin,
  ConvStatus,
  MessageDTO,
  Role,
  SectorDTO,
  SendStatus,
  SenderType,
  UserDTO,
} from '@rag/shared';
import type { Db } from './db';
import { newId, parseJson } from './util';

// ---------- Setores ----------
interface SectorRow {
  id: string; name: string; description: string; inactivity_minutes: number; queue_timeout_min: number | null;
  welcome_message: string | null; closing_message: string | null; business_hours: string | null;
}
export const sectorDto = (r: SectorRow): SectorDTO => ({
  id: r.id, name: r.name, description: r.description, inactivityMinutes: r.inactivity_minutes,
  queueTimeoutMin: r.queue_timeout_min, welcomeMessage: r.welcome_message, closingMessage: r.closing_message,
  businessHours: parseJson<BusinessHours | null>(r.business_hours, null),
});

export class SectorRepo {
  constructor(private readonly db: Db) {}
  list(): SectorDTO[] {
    return (this.db.prepare(`SELECT * FROM sectors ORDER BY name`).all() as SectorRow[]).map(sectorDto);
  }
  get(id: string): SectorDTO | null {
    const r = this.db.prepare(`SELECT * FROM sectors WHERE id = ?`).get(id) as SectorRow | undefined;
    return r ? sectorDto(r) : null;
  }
  create(s: Omit<SectorDTO, 'id'>): SectorDTO {
    const id = newId();
    this.db
      .prepare(`INSERT INTO sectors(id,name,description,inactivity_minutes,queue_timeout_min,welcome_message,closing_message,business_hours) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, s.name, s.description, s.inactivityMinutes, s.queueTimeoutMin, s.welcomeMessage, s.closingMessage, s.businessHours ? JSON.stringify(s.businessHours) : null);
    return this.get(id)!;
  }
  update(id: string, s: Omit<SectorDTO, 'id'>): SectorDTO | null {
    const res = this.db
      .prepare(`UPDATE sectors SET name=?,description=?,inactivity_minutes=?,queue_timeout_min=?,welcome_message=?,closing_message=?,business_hours=? WHERE id=?`)
      .run(s.name, s.description, s.inactivityMinutes, s.queueTimeoutMin, s.welcomeMessage, s.closingMessage, s.businessHours ? JSON.stringify(s.businessHours) : null, id);
    return res.changes ? this.get(id) : null;
  }
  inUse(id: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM users WHERE sector_id = ? UNION ALL SELECT 1 FROM conversations WHERE sector_id = ? LIMIT 1`)
      .get(id, id);
  }
  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM sectors WHERE id = ?`).run(id).changes > 0;
  }
}

// ---------- Usuários ----------
export interface UserRow {
  id: string; name: string; display_name: string; email: string; password_hash: string;
  role: Role; sector_id: string | null; active: number; token_version: number;
}
export const userDto = (r: UserRow): UserDTO => ({
  id: r.id, name: r.name, displayName: r.display_name, email: r.email, role: r.role, sectorId: r.sector_id, active: !!r.active,
});

export class UserRepo {
  constructor(private readonly db: Db) {}
  list(): UserDTO[] {
    return (this.db.prepare(`SELECT * FROM users ORDER BY name`).all() as UserRow[]).map(userDto);
  }
  row(id: string): UserRow | null {
    return (this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined) ?? null;
  }
  byEmail(email: string): UserRow | null {
    return (this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email) as UserRow | undefined) ?? null;
  }
  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM users`).get() as { n: number }).n;
  }
  create(u: { name: string; displayName: string; email: string; passwordHash: string; role: Role; sectorId: string | null; active: boolean }): UserDTO {
    const id = newId();
    this.db
      .prepare(`INSERT INTO users(id,name,display_name,email,password_hash,role,sector_id,active) VALUES (?,?,?,?,?,?,?,?)`)
      .run(id, u.name, u.displayName, u.email, u.passwordHash, u.role, u.sectorId, u.active ? 1 : 0);
    return userDto(this.row(id)!);
  }
  update(id: string, u: { name: string; displayName: string; email: string; passwordHash?: string; role: Role; sectorId: string | null; active: boolean }): UserDTO | null {
    const cur = this.row(id);
    if (!cur) return null;
    // Trocar senha, papel, setor ou desativar invalida os tokens já emitidos.
    const revoke = !!u.passwordHash || u.role !== cur.role || u.sectorId !== cur.sector_id || (!u.active && !!cur.active);
    this.db
      .prepare(`UPDATE users SET name=?,display_name=?,email=?,password_hash=?,role=?,sector_id=?,active=?,token_version=token_version+? WHERE id=?`)
      .run(u.name, u.displayName, u.email, u.passwordHash ?? cur.password_hash, u.role, u.sectorId, u.active ? 1 : 0, revoke ? 1 : 0, id);
    return userDto(this.row(id)!);
  }
  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM users WHERE id = ?`).run(id).changes > 0;
  }
  hasHistory(id: string): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM conversations WHERE assigned_user_id = ? UNION ALL SELECT 1 FROM messages WHERE sender_user_id = ? LIMIT 1`)
      .get(id, id);
  }
}

// ---------- Contatos ----------
interface ContactRow { id: string; wa_id: string; name: string | null; phone: string }
export const contactDto = (r: ContactRow): ContactDTO => ({ id: r.id, waId: r.wa_id, name: r.name, phone: r.phone });

export class ContactRepo {
  constructor(private readonly db: Db) {}
  upsert(waId: string, phone: string, name?: string): ContactDTO {
    const found = this.db.prepare(`SELECT * FROM contacts WHERE wa_id = ?`).get(waId) as ContactRow | undefined;
    if (found) {
      if (name && name !== found.name) this.db.prepare(`UPDATE contacts SET name = ? WHERE id = ?`).run(name, found.id);
      return contactDto({ ...found, name: name ?? found.name });
    }
    const id = newId();
    this.db.prepare(`INSERT INTO contacts(id,wa_id,name,phone) VALUES (?,?,?,?)`).run(id, waId, name ?? null, phone);
    return { id, waId, name: name ?? null, phone };
  }
  get(id: string): ContactDTO | null {
    const r = this.db.prepare(`SELECT * FROM contacts WHERE id = ?`).get(id) as ContactRow | undefined;
    return r ? contactDto(r) : null;
  }
}

// ---------- Conversas ----------
export interface ConvRow {
  id: string; contact_id: string; sector_id: string | null; assigned_user_id: string | null; origin: ConvOrigin;
  status: ConvStatus; failed_ai_attempts: number; menu_count: number; ever_human: number; summary: string | null;
  last_interaction_at: string; warned_at: string | null; first_response_at: string | null; human_started_at: string | null;
  closed_at: string | null; close_reason: CloseReason | null; created_at: string;
}

/** `aiEnabled` é sempre derivado no servidor (doc 02 §4): origem do cliente e status BOT. */
export const aiEnabled = (c: Pick<ConvRow, 'origin' | 'status'>): boolean => c.origin === 'CUSTOMER' && c.status === 'BOT';

export interface ConvFilter {
  /** Restringe ao setor; `undefined` = sem restrição (admin). */
  sectorId?: string | null;
  status?: ConvStatus;
  assignedUserId?: string;
  limit?: number;
}

export class ConversationRepo {
  constructor(private readonly db: Db, private readonly contacts: ContactRepo) {}

  row(id: string): ConvRow | null {
    return (this.db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as ConvRow | undefined) ?? null;
  }
  openForContact(contactId: string): ConvRow | null {
    return (this.db.prepare(`SELECT * FROM conversations WHERE contact_id = ? AND status != 'CLOSED'`).get(contactId) as ConvRow | undefined) ?? null;
  }
  create(c: { contactId: string; sectorId: string | null; assignedUserId: string | null; origin: ConvOrigin; status: ConvStatus; at: string }): ConvRow {
    const id = newId();
    this.db
      .prepare(`INSERT INTO conversations(id,contact_id,sector_id,assigned_user_id,origin,status,last_interaction_at,human_started_at,ever_human,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, c.contactId, c.sectorId, c.assignedUserId, c.origin, c.status, c.at, c.status === 'HUMAN' ? c.at : null, c.status === 'HUMAN' ? 1 : 0, c.at);
    return this.row(id)!;
  }
  /** Atualização parcial por colunas (nomes controlados pelo código, nunca vindos do usuário). */
  patch(id: string, fields: Partial<Omit<ConvRow, 'id'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE conversations SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`)
      .run({ ...fields, id });
  }
  /** Atualização condicional: só aplica se o status ainda for o esperado. Retorna se aplicou. */
  patchIfStatus(id: string, expected: ConvStatus, fields: Partial<Omit<ConvRow, 'id'>>): boolean {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    return (
      this.db
        .prepare(`UPDATE conversations SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id AND status = @expected`)
        .run({ ...fields, id, expected }).changes > 0
    );
  }

  list(f: ConvFilter): ConversationDTO[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (f.sectorId !== undefined) {
      where.push(f.sectorId === null ? 'c.sector_id IS NULL' : 'c.sector_id = @sectorId');
      if (f.sectorId !== null) params.sectorId = f.sectorId;
    }
    if (f.status) (where.push('c.status = @status'), (params.status = f.status));
    if (f.assignedUserId) (where.push('c.assigned_user_id = @assigned'), (params.assigned = f.assignedUserId));
    const rows = this.db
      .prepare(
        `SELECT c.*, ct.wa_id, ct.name AS contact_name, ct.phone,
           (SELECT substr(body, 1, 120) FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1) AS preview
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY c.last_interaction_at DESC LIMIT @limit`,
      )
      .all({ ...params, limit: f.limit ?? 200 }) as (ConvRow & { wa_id: string; contact_name: string | null; phone: string; preview: string | null })[];
    return rows.map((r) => this.toDto(r, { id: r.contact_id, waId: r.wa_id, name: r.contact_name, phone: r.phone }, r.preview));
  }

  dto(id: string): ConversationDTO | null {
    const c = this.row(id);
    if (!c) return null;
    const contact = this.contacts.get(c.contact_id)!;
    const preview = (this.db.prepare(`SELECT substr(body,1,120) b FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(id) as { b: string } | undefined)?.b ?? null;
    return this.toDto(c, contact, preview);
  }

  private toDto(c: ConvRow, contact: ContactDTO, preview: string | null): ConversationDTO {
    return {
      id: c.id, contact, sectorId: c.sector_id, assignedUserId: c.assigned_user_id, origin: c.origin, status: c.status,
      aiEnabled: aiEnabled(c), failedAiAttempts: c.failed_ai_attempts, summary: c.summary,
      lastInteractionAt: c.last_interaction_at, closedAt: c.closed_at, closeReason: c.close_reason,
      createdAt: c.created_at, lastMessagePreview: preview,
    };
  }
}

// ---------- Mensagens ----------
interface MsgRow {
  id: string; conversation_id: string; sender_type: SenderType; sender_user_id: string | null; sender_name?: string | null;
  body: string; sent_body: string | null; media_path: string | null; media_type: string | null; wa_message_id: string | null;
  ack: number; send_status: SendStatus; ai_meta: string | null; feedback: 1 | -1 | null; created_at: string;
}
const msgDto = (r: MsgRow): MessageDTO => ({
  id: r.id, conversationId: r.conversation_id, senderType: r.sender_type, senderUserId: r.sender_user_id,
  senderName: r.sender_name ?? null, body: r.body, mediaUrl: r.media_path ? `/files/${r.media_path}` : null,
  mediaType: r.media_type, ack: r.ack, sendStatus: r.send_status, aiMeta: parseJson<AiMeta | null>(r.ai_meta, null),
  feedback: r.feedback, createdAt: r.created_at,
});

export interface NewMessage {
  conversationId: string; senderType: SenderType; senderUserId?: string | null; body: string; sentBody?: string | null;
  mediaPath?: string | null; mediaType?: string | null; waMessageId?: string | null; sendStatus?: SendStatus;
  aiMeta?: AiMeta | null; at: string;
}

export class MessageRepo {
  constructor(private readonly db: Db) {}
  insert(m: NewMessage): MessageDTO {
    const id = newId();
    this.db
      .prepare(`INSERT INTO messages(id,conversation_id,sender_type,sender_user_id,body,sent_body,media_path,media_type,wa_message_id,send_status,ai_meta,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, m.conversationId, m.senderType, m.senderUserId ?? null, m.body, m.sentBody ?? null, m.mediaPath ?? null, m.mediaType ?? null, m.waMessageId ?? null, m.sendStatus ?? 'SENT', m.aiMeta ? JSON.stringify(m.aiMeta) : null, m.at);
    return this.get(id)!;
  }
  get(id: string): MessageDTO | null {
    const r = this.db
      .prepare(`SELECT m.*, u.display_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.id = ?`)
      .get(id) as MsgRow | undefined;
    return r ? msgDto(r) : null;
  }
  existsByWaId(waMessageId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM messages WHERE wa_message_id = ?`).get(waMessageId);
  }
  byWaId(waMessageId: string): MessageDTO | null {
    const r = this.db.prepare(`SELECT id FROM messages WHERE wa_message_id = ?`).get(waMessageId) as { id: string } | undefined;
    return r ? this.get(r.id) : null;
  }
  list(conversationId: string, limit = 500): MessageDTO[] {
    return (
      this.db
        .prepare(`SELECT m.*, u.display_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_user_id WHERE m.conversation_id = ? ORDER BY m.created_at, m.rowid LIMIT ?`)
        .all(conversationId, limit) as MsgRow[]
    ).map(msgDto);
  }
  recent(conversationId: string, n: number): MessageDTO[] {
    return (
      this.db
        .prepare(`SELECT * FROM (SELECT m.*, m.rowid AS rid, NULL AS sender_name FROM messages m WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rid`)
        .all(conversationId, n) as MsgRow[]
    ).map(msgDto);
  }
  setSent(id: string, waMessageId: string): void {
    this.db.prepare(`UPDATE messages SET wa_message_id = ?, send_status = 'SENT', ack = MAX(ack, 1) WHERE id = ?`).run(waMessageId, id);
  }
  setFailed(id: string): void {
    this.db.prepare(`UPDATE messages SET send_status = 'FAILED' WHERE id = ?`).run(id);
  }
  setAck(waMessageId: string, ack: number): string | null {
    const r = this.db.prepare(`SELECT id, ack FROM messages WHERE wa_message_id = ?`).get(waMessageId) as { id: string; ack: number } | undefined;
    if (!r || ack <= r.ack) return null; // confirmações nunca regridem
    this.db.prepare(`UPDATE messages SET ack = ? WHERE id = ?`).run(ack, r.id);
    return r.id;
  }
  setFeedback(id: string, feedback: 1 | -1 | null): void {
    this.db.prepare(`UPDATE messages SET feedback = ? WHERE id = ?`).run(feedback, id);
  }
  countBySender(conversationId: string, senderType: SenderType): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM messages WHERE conversation_id = ? AND sender_type = ?`).get(conversationId, senderType) as { n: number }).n;
  }
}
