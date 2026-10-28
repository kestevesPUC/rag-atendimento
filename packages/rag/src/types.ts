export interface EmbeddingProvider {
  /** Identificador do modelo; gravado no banco para detectar troca de modelo. */
  readonly id: string;
  readonly dimensions: number;
  embedQuery(text: string): Promise<Float32Array>;
  embedPassages(texts: string[]): Promise<Float32Array[]>;
}

export interface ChunkInput {
  documentId: string;
  sectorIds: string[]; // vazio = global
  content: string;
  metadata?: { title?: string; section?: string; page?: number; kind?: 'faq' | 'text' };
}

export interface StoredChunk extends ChunkInput {
  id: number;
  contentHash: string;
}

export interface SearchHit {
  chunkId: number;
  documentId: string;
  content: string;
  metadata: ChunkInput['metadata'];
  /** Similaridade de cosseno (0..1) da busca vetorial; 0 se só veio do full-text. */
  vectorScore: number;
  /** Pontuação final após fusão (RRF) e rerank. */
  score: number;
}

export interface VectorStore {
  /** Substitui todos os chunks de um documento. Retorna quantos foram gravados. */
  replaceDocument(documentId: string, chunks: ChunkInput[]): Promise<number>;
  deleteDocument(documentId: string): void;
  /** Troca os setores de um documento sem regerar embeddings. */
  updateDocumentSectors(documentId: string, sectorIds: string[]): void;
  search(query: string, opts: { sectorId: string | null; allSectors?: boolean; limit?: number }): Promise<SearchHit[]>;
  countChunks(): number;
  close(): void;
}

export interface Reranker {
  rerank(query: string, hits: SearchHit[]): SearchHit[];
}

export class EmbeddingModelMismatchError extends Error {
  constructor(stored: string, current: string) {
    super(`O banco vetorial foi criado com o modelo "${stored}", mas o modelo atual é "${current}". Reindexe os documentos.`);
    this.name = 'EmbeddingModelMismatchError';
  }
}
