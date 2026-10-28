import type { Db } from './db';
import { iso, type Clock, type Logger, silentLogger } from './util';

export type JobHandler = (payload: Record<string, unknown>, job: { id: number; attempts: number }) => Promise<void>;

export interface EnqueueOptions {
  runAt?: Date;
  /** Se já existir um job pendente com esta chave, apenas adia/atualiza esse (debounce) em vez de duplicar. */
  dedupeKey?: string;
}

interface JobRow { id: number; type: string; payload: string; attempts: number }

const BATCH = 10;

/** Fila de jobs persistida em SQLite (sem Redis — doc 02). Processa em ordem de `run_at`, com retentativa. */
export class JobQueue {
  private readonly handlers = new Map<string, { fn: JobHandler; maxAttempts: number }>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private inFlight = new Set<Promise<void>>();

  constructor(private readonly db: Db, private readonly clock: Clock, private readonly log: Logger = silentLogger) {}

  register(type: string, fn: JobHandler, maxAttempts = 3): void {
    this.handlers.set(type, { fn, maxAttempts });
  }

  enqueue(type: string, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}): void {
    const now = this.clock.now();
    const runAt = iso(opts.runAt ?? now);
    if (opts.dedupeKey) {
      const res = this.db
        .prepare(`UPDATE jobs SET run_at = ?, payload = ? WHERE dedupe_key = ? AND status = 'PENDING'`)
        .run(runAt, JSON.stringify(payload), opts.dedupeKey);
      if (res.changes) return; // reaproveitou o pendente (debounce) — sem duplicar
    }
    this.db
      .prepare(`INSERT INTO jobs(type, payload, run_at, dedupe_key, created_at, attempts) VALUES (?,?,?,?,?,?)`)
      .run(type, JSON.stringify(payload), runAt, opts.dedupeKey ?? null, iso(now), 0);
  }

  /** Jobs que ficaram RUNNING por uma queda voltam para a fila (as tarefas são idempotentes). */
  recover(): number {
    return this.db.prepare(`UPDATE jobs SET status = 'PENDING' WHERE status = 'RUNNING'`).run().changes;
  }

  /** Executa os jobs vencidos uma vez. Útil nos testes (com relógio controlado). */
  async runDue(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      const due = this.db
        .prepare(`SELECT id, type, payload, attempts FROM jobs WHERE status = 'PENDING' AND run_at <= ? ORDER BY run_at, id LIMIT ?`)
        .all(iso(this.clock.now()), BATCH) as JobRow[];
      const claim = this.db.prepare(`UPDATE jobs SET status = 'RUNNING', attempts = attempts + 1 WHERE id = ? AND status = 'PENDING'`);
      const mine = due.filter((j) => claim.run(j.id).changes === 1);
      await Promise.all(mine.map((j) => this.execute(j)));
      return mine.length;
    } finally {
      this.ticking = false;
    }
  }

  private execute(job: JobRow): Promise<void> {
    const h = this.handlers.get(job.type);
    const p = (async () => {
      try {
        if (!h) throw new Error(`Sem handler para o job "${job.type}".`);
        await h.fn(JSON.parse(job.payload) as Record<string, unknown>, { id: job.id, attempts: job.attempts + 1 });
        this.db.prepare(`UPDATE jobs SET status = 'DONE' WHERE id = ?`).run(job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = job.attempts + 1;
        const retry = !!h && attempts < h.maxAttempts;
        this.log.warn({ job: job.id, type: job.type, attempts, err: message }, 'job falhou');
        const backoffMs = Math.min(5 * 60_000, 2000 * 2 ** (attempts - 1));
        this.db
          .prepare(`UPDATE jobs SET status = ?, last_error = ?, run_at = ? WHERE id = ?`)
          .run(retry ? 'PENDING' : 'FAILED', message.slice(0, 500), iso(new Date(this.clock.now().getTime() + backoffMs)), job.id);
      }
    })();
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return p;
  }

  start(pollMs = 500): void {
    this.recover();
    this.timer = setInterval(() => void this.runDue().catch((e) => this.log.error({ e }, 'tick falhou')), pollMs);
    this.timer.unref?.();
  }

  /** Para o laço e espera os jobs em andamento terminarem. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.allSettled([...this.inFlight]);
  }

  /** Remove registros concluídos há mais de um dia. */
  purge(): void {
    const cutoff = iso(new Date(this.clock.now().getTime() - 24 * 3600_000));
    this.db.prepare(`DELETE FROM jobs WHERE status = 'DONE' AND created_at < ?`).run(cutoff);
  }

  /** Jobs pendentes de um tipo (testes e diagnóstico). */
  pending(type: string): number {
    return (this.db.prepare(`SELECT COUNT(*) n FROM jobs WHERE type = ? AND status = 'PENDING'`).get(type) as { n: number }).n;
  }
}
