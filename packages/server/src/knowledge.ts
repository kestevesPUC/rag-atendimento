import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chunkFromFaq, chunksFromDocument, detectDocType, extractFromBuffer, extractFromUrl, type DocType, type VectorStore } from '@rag/rag';
import { ServerEvents, type DocStatus } from '@rag/shared';
import type { AuthUser } from './auth';
import type { EventBus } from './bus';
import { rooms } from './bus';
import type { ConversationService } from './conversations';
import type { Db } from './db';
import type { JobQueue } from './jobs';
import type { MessageRepo, SectorRepo } from './repos';
import { badRequest, forbidden, iso, newId, notFound, parseJson, type Clock, type Logger } from './util';

export interface DocumentDTO {
  id: string;
  title: string;
  type: string;
  sectorIds: string[];
  status: DocStatus;
  error: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

interface DocRow {
  id: string; title: string; type: string; sector_ids: string; status: DocStatus; error: string | null;
  source: string | null; file_path: string | null; chunk_count: number; created_at: string; updated_at: string;
}
const dto = (r: DocRow): DocumentDTO => ({
  id: r.id, title: r.title, type: r.type, sectorIds: parseJson<string[]>(r.sector_ids, []), status: r.status,
  error: r.error, chunkCount: r.chunk_count, createdAt: r.created_at, updatedAt: r.updated_at,
});

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface KnowledgeDeps {
  db: Db;
  clock: Clock;
  store: VectorStore;
  jobs: JobQueue;
  bus: EventBus;
  sectors: SectorRepo;
  msgs: MessageRepo;
  conversations: ConversationService;
  dir: string;
  log: Logger;
}

export class KnowledgeService {
  constructor(private readonly d: KnowledgeDeps) {
    mkdirSync(d.dir, { recursive: true });
    d.jobs.register('ingest-document', (p) => this.ingest(String(p.documentId)), 2);
  }

  private now = () => iso(this.d.clock.now());
  private row(id: string): DocRow {
    const r = this.d.db.prepare(`SELECT * FROM knowledge_documents WHERE id = ?`).get(id) as DocRow | undefined;
    if (!r) throw notFound('Documento');
    return r;
  }
  private emit(id: string): void {
    this.d.bus.publish([rooms.admins], ServerEvents.documentUpdated, dto(this.row(id)));
  }
  private validateSectors(ids: string[]): void {
    for (const s of ids) if (!this.d.sectors.get(s)) throw badRequest('Setor inexistente na lista de setores do documento.');
  }
  private insert(o: { title: string; type: string; sectorIds: string[]; source?: string; filePath?: string }): string {
    this.validateSectors(o.sectorIds);
    const id = newId();
    this.d.db
      .prepare(`INSERT INTO knowledge_documents(id,title,type,sector_ids,status,source,file_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, o.title, o.type, JSON.stringify(o.sectorIds), 'PENDING', o.source ?? null, o.filePath ?? null, this.now(), this.now());
    this.d.jobs.enqueue('ingest-document', { documentId: id });
    this.emit(id);
    return id;
  }

  list(): DocumentDTO[] {
    return (this.d.db.prepare(`SELECT * FROM knowledge_documents ORDER BY created_at DESC`).all() as DocRow[]).map(dto);
  }

  addFile(filename: string, buffer: Buffer, sectorIds: string[]): DocumentDTO {
    const type = detectDocType(filename);
    if (!type) throw badRequest('Formato não suportado. Use PDF, DOCX, TXT ou MD.');
    if (buffer.length > MAX_UPLOAD_BYTES) throw badRequest('Arquivo maior que 20 MB.');
    const stored = `${newId()}.${type}`; // o nome enviado pelo cliente nunca vai para o caminho do disco
    writeFileSync(join(this.d.dir, stored), buffer);
    const title = filename.replace(/\.[^.]+$/, '').slice(0, 120) || 'Documento';
    return dto(this.row(this.insert({ title, type, sectorIds, filePath: stored })));
  }

  addFaq(question: string, answer: string, sectorIds: string[]): DocumentDTO {
    return dto(this.row(this.insert({ title: question.slice(0, 120), type: 'faq', sectorIds, source: JSON.stringify({ question, answer }) })));
  }

  addUrl(url: string, sectorIds: string[]): DocumentDTO {
    return dto(this.row(this.insert({ title: url.slice(0, 120), type: 'url', sectorIds, source: url })));
  }

  /** RF18: transforma uma resposta humana em FAQ. A pergunta padrão é o que o cliente disse antes. */
  addFromMessage(user: AuthUser, messageId: string, override?: { question?: string; answer?: string }): DocumentDTO {
    const msg = this.d.msgs.get(messageId);
    if (!msg) throw notFound('Mensagem');
    const conv = this.d.conversations.getForUser(user, msg.conversationId); // 404 para outro setor
    if (msg.senderType !== 'AGENT') throw badRequest('Só respostas de atendentes podem ser adicionadas à base.');
    const all = this.d.msgs.list(conv.id);
    const idx = all.findIndex((m) => m.id === messageId);
    const question =
      override?.question ??
      all.slice(0, idx).reverse().find((m) => m.senderType === 'CUSTOMER' && m.body.trim())?.body ??
      '';
    const answer = (override?.answer ?? msg.body).trim();
    if (question.trim().length < 3 || answer.length < 3) throw badRequest('Informe a pergunta e a resposta para criar o FAQ.');
    return this.addFaq(question.trim(), answer, conv.sector_id ? [conv.sector_id] : []);
  }

  updateSectors(id: string, sectorIds: string[]): DocumentDTO {
    this.row(id);
    this.validateSectors(sectorIds);
    this.d.db.prepare(`UPDATE knowledge_documents SET sector_ids = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(sectorIds), this.now(), id);
    this.d.store.updateDocumentSectors(id, sectorIds);
    return dto(this.row(id));
  }

  reprocess(id: string): DocumentDTO {
    const r = this.row(id);
    if (r.status === 'PROCESSING') throw forbidden('O documento já está sendo processado.');
    this.d.db.prepare(`UPDATE knowledge_documents SET status = 'PENDING', error = NULL, updated_at = ? WHERE id = ?`).run(this.now(), id);
    this.d.jobs.enqueue('ingest-document', { documentId: id }, { dedupeKey: `ingest:${id}` });
    this.emit(id);
    return dto(this.row(id));
  }

  delete(id: string): void {
    const r = this.row(id);
    this.d.store.deleteDocument(id);
    if (r.file_path) rmSync(join(this.d.dir, r.file_path), { force: true });
    this.d.db.prepare(`DELETE FROM knowledge_documents WHERE id = ?`).run(id);
    this.d.bus.publish([rooms.admins], ServerEvents.documentUpdated, { id, deleted: true });
  }

  /** Job `ingest-document`: extrai, divide em chunks e indexa. Falhas viram status FAILED com a causa. */
  async ingest(id: string): Promise<void> {
    const r = this.d.db.prepare(`SELECT * FROM knowledge_documents WHERE id = ?`).get(id) as DocRow | undefined;
    if (!r) return; // excluído enquanto esperava na fila
    this.d.db.prepare(`UPDATE knowledge_documents SET status = 'PROCESSING', error = NULL WHERE id = ?`).run(id);
    this.emit(id);
    const sectorIds = parseJson<string[]>(r.sector_ids, []);
    try {
      let chunks;
      let title = r.title;
      if (r.type === 'faq') {
        const { question, answer } = JSON.parse(r.source ?? '{}') as { question: string; answer: string };
        chunks = [chunkFromFaq(id, question, answer, sectorIds)];
      } else if (r.type === 'url') {
        const doc = await extractFromUrl(r.source!);
        title = doc.title?.slice(0, 120) || title;
        chunks = chunksFromDocument(id, title, doc, sectorIds);
      } else {
        const path = join(this.d.dir, r.file_path ?? '');
        if (!r.file_path || !existsSync(path)) throw new Error('Arquivo original não encontrado.');
        const doc = await extractFromBuffer(readFileSync(path), r.type as DocType);
        chunks = chunksFromDocument(id, title, doc, sectorIds);
      }
      if (!chunks.length) throw new Error('Nenhum texto foi encontrado no documento.');
      const n = await this.d.store.replaceDocument(id, chunks);
      this.d.db.prepare(`UPDATE knowledge_documents SET status='READY', title=?, chunk_count=?, updated_at=? WHERE id=?`).run(title, n, this.now(), id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.d.log.warn({ id, err: message }, 'falha na ingestão');
      this.d.db.prepare(`UPDATE knowledge_documents SET status='FAILED', error=?, updated_at=? WHERE id=?`).run(message.slice(0, 300), this.now(), id);
    }
    this.emit(id);
  }
}
