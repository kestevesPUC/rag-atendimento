import type { Db } from './db';

export interface ReportOptions {
  from?: string;
  to?: string;
  sectorId: string | null;
  /** "Agora" vem do relógio injetado do sistema, nunca de `new Date()`. */
  now: Date;
}

export interface ReportSummary {
  period: { from: string; to: string };
  totals: { conversations: number; closed: number; customerOrigin: number; agentOrigin: number };
  aiResolutionRate: number | null;
  transfers: number;
  avgFirstResponseSeconds: number | null;
  avgHandlingSeconds: number | null;
  bySector: { sectorId: string | null; name: string; conversations: number }[];
  byAgent: { userId: string; name: string; conversations: number; messages: number }[];
  /** Perguntas que a IA não soube responder: indicam lacunas na base (doc 03 §7). */
  gaps: { conversationId: string; question: string; topScore: number | null; at: string }[];
  feedback: { up: number; down: number };
}

const DEFAULT_DAYS = 30;

/** Métricas do período (criadas dentro dele). `sectorId` restringe tudo ao setor. */
export function reportSummary(db: Db, o: ReportOptions): ReportSummary {
  const to = o.to ?? o.now.toISOString();
  const from = o.from ?? new Date(Date.parse(to) - DEFAULT_DAYS * 86400_000).toISOString();
  const p = { from, to, sector: o.sectorId };
  const scope = `c.created_at >= @from AND c.created_at <= @to AND (@sector IS NULL OR c.sector_id = @sector)`;
  const one = <T>(sql: string) => db.prepare(sql).get(p) as T;
  const all = <T>(sql: string) => db.prepare(sql).all(p) as T[];

  const t = one<{ n: number; closed: number; cust: number; agent: number }>(
    `SELECT COUNT(*) n, SUM(status='CLOSED') closed, SUM(origin='CUSTOMER') cust, SUM(origin='AGENT') agent FROM conversations c WHERE ${scope}`,
  );
  // Resolvida pela IA = conversa do cliente, encerrada, que nunca teve humano (D-024).
  const ai = one<{ closed: number; byAi: number }>(
    `SELECT COUNT(*) closed, SUM(ever_human = 0) byAi FROM conversations c WHERE ${scope} AND origin='CUSTOMER' AND status='CLOSED'`,
  );
  const transfers = one<{ n: number }>(
    `SELECT COUNT(DISTINCT c.id) n FROM conversations c JOIN messages m ON m.conversation_id = c.id
     WHERE ${scope} AND json_extract(m.ai_meta, '$.kind') = 'transfer'`,
  ).n;
  const fb = one<{ up: number | null; down: number | null }>(
    `SELECT SUM(m.feedback = 1) up, SUM(m.feedback = -1) down FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE ${scope} AND m.sender_type = 'AI'`,
  );
  const avg = (expr: string, extra = '') =>
    one<{ v: number | null }>(`SELECT AVG(${expr}) v FROM conversations c WHERE ${scope} ${extra}`).v;

  return {
    period: { from, to },
    totals: { conversations: t.n, closed: t.closed ?? 0, customerOrigin: t.cust ?? 0, agentOrigin: t.agent ?? 0 },
    aiResolutionRate: ai.closed ? (ai.byAi ?? 0) / ai.closed : null,
    transfers,
    avgFirstResponseSeconds: avg(`(julianday(first_response_at) - julianday(created_at)) * 86400`, `AND first_response_at IS NOT NULL`),
    avgHandlingSeconds: avg(`(julianday(closed_at) - julianday(human_started_at)) * 86400`, `AND ever_human = 1 AND closed_at IS NOT NULL AND human_started_at IS NOT NULL`),
    bySector: all<{ sectorId: string | null; name: string | null; conversations: number }>(
      `SELECT c.sector_id sectorId, s.name name, COUNT(*) conversations FROM conversations c LEFT JOIN sectors s ON s.id = c.sector_id
       WHERE ${scope} GROUP BY c.sector_id ORDER BY conversations DESC`,
    ).map((r) => ({ ...r, name: r.name ?? 'Sem setor' })),
    byAgent: all<{ userId: string; name: string; conversations: number; messages: number }>(
      `SELECT u.id userId, u.display_name name,
              COUNT(DISTINCT c.id) conversations,
              (SELECT COUNT(*) FROM messages m WHERE m.sender_user_id = u.id AND m.sender_type = 'AGENT'
                 AND m.created_at >= @from AND m.created_at <= @to) messages
       FROM conversations c JOIN users u ON u.id = c.assigned_user_id WHERE ${scope} GROUP BY u.id ORDER BY conversations DESC`,
    ),
    gaps: all<{ conversationId: string; question: string; topScore: number | null; at: string }>(
      `SELECT c.id conversationId, json_extract(m.ai_meta, '$.topScore') topScore, m.created_at at,
              (SELECT body FROM messages q WHERE q.conversation_id = c.id AND q.sender_type = 'CUSTOMER' AND q.created_at <= m.created_at
                 AND q.body != '' ORDER BY q.created_at DESC, q.rowid DESC LIMIT 1) question
       FROM conversations c JOIN messages m ON m.conversation_id = c.id
       WHERE ${scope} AND json_extract(m.ai_meta, '$.reason') = 'LOW_CONFIDENCE' ORDER BY m.created_at DESC LIMIT 50`,
    ).filter((g) => g.question),
    feedback: { up: fb.up ?? 0, down: fb.down ?? 0 },
  };
}
