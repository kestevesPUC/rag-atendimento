import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EmbeddingModelMismatchError,
  HashEmbeddingProvider,
  SqliteVectorStore,
  assertPublicUrl,
  chunkFromFaq,
  chunkText,
  chunksFromDocument,
  extractFromBuffer,
  extractFromUrl,
  type EmbeddingProvider,
} from '../src';

let dir: string;
const opened: SqliteVectorStore[] = [];
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'rag-test-'))));
afterEach(() => {
  // fecha antes de apagar: no Windows um SQLite aberto impede remover a pasta
  for (const s of opened.splice(0)) {
    try {
      s.close();
    } catch {
      /* já fechado pelo teste */
    }
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('chunkText', () => {
  it('mantém o título como seção e não ultrapassa o tamanho máximo', () => {
    const para = 'Esta é uma frase de exemplo sobre reembolso. '.repeat(60).trim();
    const text = `# Política de reembolso\n\n${para}\n\n${para}\n\n${para}\n\n## Prazos\n\nO prazo é de 7 dias.`;
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]!.section).toBe('Política de reembolso');
    expect(chunks.at(-1)!.section).toBe('Prazos');
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(800 * 4 + 400);
  });

  it('aplica sobreposição entre chunks da mesma seção', () => {
    const sentences = Array.from({ length: 120 }, (_, i) => `Frase numero ${i} do manual do produto.`).join(' ');
    const [a, b] = chunkText(sentences, undefined, { targetTokens: 100, maxTokens: 120, overlapTokens: 20 });
    expect(a && b).toBeTruthy();
    const lastOfA = a!.content.split(/(?<=\.)\s/).at(-1)!;
    expect(b!.content).toContain(lastOfA);
  });

  it('não gera chunks vazios para texto vazio', () => {
    expect(chunkText('  \n\n ')).toEqual([]);
  });
});

describe('SqliteVectorStore', () => {
  const embedder = new HashEmbeddingProvider();
  const open = () => {
    const s = new SqliteVectorStore(join(dir, 'k.db'), embedder);
    opened.push(s);
    return s;
  };

  const doc = (id: string, text: string, sectorIds: string[]) =>
    chunksFromDocument(id, id, { sections: [{ text }] }, sectorIds);

  it('encontra o trecho relevante e respeita o filtro de setor', async () => {
    const store = open();
    await store.replaceDocument('fin', doc('fin', 'Boleto vencido pode ser pago com juros de dois por cento no site.', ['financeiro']));
    await store.replaceDocument('sup', doc('sup', 'Para resetar a senha do aplicativo use a opção esqueci minha senha.', ['suporte']));
    await store.replaceDocument('glob', doc('glob', 'Nosso horário de funcionamento é de segunda a sexta.', []));

    const fin = await store.search('como pagar boleto vencido', { sectorId: 'financeiro' });
    expect(fin[0]!.documentId).toBe('fin');
    expect(fin.some((h) => h.documentId === 'sup')).toBe(false);

    const sup = await store.search('como pagar boleto vencido', { sectorId: 'suporte' });
    expect(sup.some((h) => h.documentId === 'fin')).toBe(false);

    const globalOnly = await store.search('horário de funcionamento', { sectorId: null });
    expect(globalOnly.map((h) => h.documentId)).toEqual(['glob']);
    // Sem setor só o conteúdo global é visível. A busca devolve o vizinho mais próximo mesmo
    // quando irrelevante; quem rejeita é o limiar da camada de IA (D-013).
    const unrelated = await store.search('senha do aplicativo', { sectorId: null });
    expect(unrelated.every((h) => h.documentId === 'glob')).toBe(true);
    expect(unrelated[0]!.vectorScore).toBeLessThan(0.55);
    store.close();
  });

  it('allSectors ignora o filtro (playground)', async () => {
    const store = open();
    await store.replaceDocument('sup', doc('sup', 'Resetar senha do aplicativo.', ['suporte']));
    const hits = await store.search('resetar senha', { sectorId: null, allSectors: true });
    expect(hits[0]?.documentId).toBe('sup');
    store.close();
  });

  it('FAQ: pergunta parecida recupera a resposta com score alto', async () => {
    const store = open();
    await store.replaceDocument('faq1', [chunkFromFaq('faq1', 'Qual o prazo de entrega?', 'O prazo é de 5 dias úteis.', [])]);
    const [hit] = await store.search('qual é o prazo de entrega', { sectorId: null });
    expect(hit!.content).toContain('5 dias úteis');
    expect(hit!.vectorScore).toBeGreaterThan(0.55);
    store.close();
  });

  it('reprocessa só o que mudou (hash do conteúdo) e remove o que saiu', async () => {
    let embedded = 0;
    const counting: EmbeddingProvider = {
      id: embedder.id,
      dimensions: embedder.dimensions,
      embedQuery: (t) => embedder.embedQuery(t),
      embedPassages: (ts) => ((embedded += ts.length), embedder.embedPassages(ts)),
    };
    const store = new SqliteVectorStore(join(dir, 'h.db'), counting);
    opened.push(store);
    const a = chunkFromFaq('d', 'Pergunta A?', 'Resposta A.', []);
    const b = chunkFromFaq('d', 'Pergunta B?', 'Resposta B.', []);
    await store.replaceDocument('d', [a, b]);
    expect(embedded).toBe(2);
    await store.replaceDocument('d', [a, chunkFromFaq('d', 'Pergunta C?', 'Resposta C.', [])]);
    expect(embedded).toBe(3); // só o chunk novo
    expect(store.countChunks()).toBe(2);
    const gone = await store.search('Resposta B', { sectorId: null });
    expect(gone.some((h) => h.content.includes('Resposta B'))).toBe(false);
    store.deleteDocument('d');
    expect(store.countChunks()).toBe(0);
    store.close();
  });

  it('recusa abrir um banco criado com outro modelo de embeddings', () => {
    open().close();
    const other: EmbeddingProvider = { ...embedder, id: 'outro-modelo', embedQuery: embedder.embedQuery, embedPassages: embedder.embedPassages };
    expect(() => new SqliteVectorStore(join(dir, 'k.db'), other)).toThrow(EmbeddingModelMismatchError);
  });
});

describe('extração', () => {
  it('extrai texto de .txt e .md', async () => {
    const out = await extractFromBuffer(Buffer.from('Olá\r\n\r\n\r\n\r\nMundo'), 'txt');
    expect(out.sections[0]!.text).toBe('Olá\n\nMundo');
  });

  it('bloqueia URLs internas e protocolos não http', async () => {
    await expect(assertPublicUrl('http://127.0.0.1/admin')).rejects.toThrow(/interno/);
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/interno/);
    await expect(assertPublicUrl('http://192.168.0.10/')).rejects.toThrow(/interno/);
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/http/);
  });

  it('extrai o conteúdo principal de uma página (fetch simulado)', async () => {
    const html = `<html><head><title>Ajuda</title></head><body><nav>menu</nav><article><h1>Trocas</h1>
      <p>${'Aceitamos trocas em até 30 dias após a compra, com nota fiscal. '.repeat(8)}</p></article></body></html>`;
    const fake = (async () => new Response(html, { status: 200 })) as typeof fetch;
    const doc = await extractFromUrl('http://93.184.216.34/ajuda', fake);
    expect(doc.sections[0]!.text).toContain('trocas em até 30 dias');
  });
});
