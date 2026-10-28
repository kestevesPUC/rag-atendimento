import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { tokenize } from './embeddings';
import { LexicalReranker } from './rerank';
import {
  EmbeddingModelMismatchError,
  type ChunkInput,
  type EmbeddingProvider,
  type Reranker,
  type SearchHit,
  type VectorStore,
} from './types';

const RRF_K = 60;
const CANDIDATES = 20;
/** O filtro por setor é aplicado depois da busca vetorial; buscamos mais candidatos para compensar. */
const VEC_OVERFETCH = 100;

export interface SearchOptions {
  sectorId: string | null;
  /** Ignora o filtro de setor (usado no playground do admin). */
  allSectors?: boolean;
  limit?: number;
}

const toBlob = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Banco vetorial em SQLite: sqlite-vec (cosseno) + FTS5, fundidos por Reciprocal Rank Fusion. */
export class SqliteVectorStore implements VectorStore {
  private readonly db: Database.Database;

  constructor(
    path: string,
    private readonly embedder: EmbeddingProvider,
    private readonly reranker: Reranker = new LexicalReranker(),
  ) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    try {
      sqliteVec.load(this.db);
      this.migrate();
    } catch (err) {
      this.db.close(); // não vaza o arquivo aberto (no Windows impediria apagar/mover o banco)
      throw err;
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        document_id TEXT NOT NULL,
        sector_ids TEXT NOT NULL DEFAULT '[]',
        content TEXT NOT NULL,
        metadata TEXT,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, tokenize='unicode61 remove_diacritics 2');
    `);
    const stored = this.db.prepare(`SELECT value FROM meta WHERE key='embedding_model'`).get() as { value: string } | undefined;
    if (stored && stored.value !== this.embedder.id) throw new EmbeddingModelMismatchError(stored.value, this.embedder.id);
    if (!stored) this.db.prepare(`INSERT INTO meta(key,value) VALUES('embedding_model', ?)`).run(this.embedder.id);
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${this.embedder.dimensions}] distance_metric=cosine)`,
    );
  }

  async replaceDocument(documentId: string, chunks: ChunkInput[]): Promise<number> {
    const existing = this.db
      .prepare(`SELECT id, content_hash FROM chunks WHERE document_id = ?`)
      .all(documentId) as { id: number; content_hash: string }[];
    const byHash = new Map<string, number[]>();
    for (const e of existing) byHash.set(e.content_hash, [...(byHash.get(e.content_hash) ?? []), e.id]);

    // Reaproveita chunks idênticos (hash do conteúdo) e só gera embeddings para o que mudou.
    const keep = new Set<number>();
    const fresh: { chunk: ChunkInput; hash: string }[] = [];
    for (const chunk of chunks) {
      const hash = sha(chunk.content);
      const reuse = byHash.get(hash)?.shift();
      if (reuse !== undefined) keep.add(reuse);
      else fresh.push({ chunk, hash });
    }
    const vectors = fresh.length ? await this.embedder.embedPassages(fresh.map((f) => f.chunk.content)) : [];

    const delChunk = this.db.prepare(`DELETE FROM chunks WHERE id = ?`);
    const delVec = this.db.prepare(`DELETE FROM chunks_vec WHERE chunk_id = ?`);
    const delFts = this.db.prepare(`DELETE FROM chunks_fts WHERE rowid = ?`);
    const insChunk = this.db.prepare(
      `INSERT INTO chunks(document_id, sector_ids, content, metadata, content_hash) VALUES (?,?,?,?,?)`,
    );
    const insVec = this.db.prepare(`INSERT INTO chunks_vec(chunk_id, embedding) VALUES (?, ?)`);
    const insFts = this.db.prepare(`INSERT INTO chunks_fts(rowid, content) VALUES (?, ?)`);
    const updSectors = this.db.prepare(`UPDATE chunks SET sector_ids = ? WHERE id = ?`);

    this.db.transaction(() => {
      for (const e of existing) {
        if (keep.has(e.id)) continue;
        delVec.run(BigInt(e.id));
        delFts.run(BigInt(e.id));
        delChunk.run(e.id);
      }
      const sectors = JSON.stringify(chunks[0]?.sectorIds ?? []);
      for (const id of keep) updSectors.run(sectors, id);
      fresh.forEach(({ chunk, hash }, i) => {
        const id = Number(
          insChunk.run(documentId, JSON.stringify(chunk.sectorIds), chunk.content, JSON.stringify(chunk.metadata ?? {}), hash)
            .lastInsertRowid,
        );
        insVec.run(BigInt(id), toBlob(vectors[i]!));
        insFts.run(BigInt(id), chunk.content);
      });
    })();
    return chunks.length;
  }

  updateDocumentSectors(documentId: string, sectorIds: string[]): void {
    this.db.prepare(`UPDATE chunks SET sector_ids = ? WHERE document_id = ?`).run(JSON.stringify(sectorIds), documentId);
  }

  deleteDocument(documentId: string): void {
    const ids = this.db.prepare(`SELECT id FROM chunks WHERE document_id = ?`).all(documentId) as { id: number }[];
    this.db.transaction(() => {
      for (const { id } of ids) {
        this.db.prepare(`DELETE FROM chunks_vec WHERE chunk_id = ?`).run(BigInt(id));
        this.db.prepare(`DELETE FROM chunks_fts WHERE rowid = ?`).run(BigInt(id));
      }
      this.db.prepare(`DELETE FROM chunks WHERE document_id = ?`).run(documentId);
    })();
  }

  countChunks(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM chunks`).get() as { n: number }).n;
  }

  private ftsQuery(query: string): string | null {
    const terms = [...new Set(tokenize(query))].slice(0, 12);
    return terms.length ? terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ') : null;
  }

  async search(query: string, opts: SearchOptions): Promise<SearchHit[]> {
    const limit = opts.limit ?? 5;
    const qv = await this.embedder.embedQuery(query);

    const vec = this.db
      .prepare(`SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?`)
      .all(toBlob(qv), VEC_OVERFETCH) as { chunk_id: number; distance: number }[];

    const match = this.ftsQuery(query);
    const fts = match
      ? (this.db
          .prepare(`SELECT rowid AS chunk_id FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?`)
          .all(match, VEC_OVERFETCH) as { chunk_id: number }[])
      : [];

    const ids = [...new Set([...vec.map((v) => v.chunk_id), ...fts.map((f) => f.chunk_id)])];
    if (!ids.length) return [];
    const rows = this.db
      .prepare(`SELECT id, document_id, sector_ids, content, metadata FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: number; document_id: string; sector_ids: string; content: string; metadata: string | null }[];
    const visible = new Map(
      rows
        .filter((r) => {
          if (opts.allSectors) return true;
          const sectors = JSON.parse(r.sector_ids) as string[];
          return sectors.length === 0 || (opts.sectorId !== null && sectors.includes(opts.sectorId));
        })
        .map((r) => [r.id, r]),
    );

    const similarity = new Map(vec.map((v) => [v.chunk_id, Math.max(0, 1 - v.distance)]));
    const rrf = new Map<number, number>();
    const fuse = (list: { chunk_id: number }[]) =>
      list
        .filter((x) => visible.has(x.chunk_id))
        .forEach((x, rank) => rrf.set(x.chunk_id, (rrf.get(x.chunk_id) ?? 0) + 1 / (RRF_K + rank + 1)));
    fuse(vec);
    fuse(fts);

    const top = [...rrf.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES);
    const hits: SearchHit[] = top.map(([id, score]) => {
      const row = visible.get(id)!;
      return {
        chunkId: id,
        documentId: row.document_id,
        content: row.content,
        metadata: row.metadata ? JSON.parse(row.metadata) : {},
        vectorScore: similarity.get(id) ?? 0,
        score,
      };
    });
    return this.reranker.rerank(query, hits).slice(0, limit);
  }

  close(): void {
    this.db.close();
  }
}
