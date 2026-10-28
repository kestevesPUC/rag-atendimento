export interface RawChunk {
  content: string;
  section?: string;
  page?: number;
}

export interface ChunkOptions {
  /** Tamanho-alvo em tokens (aproximação: 1 token ≈ 4 caracteres). */
  targetTokens?: number;
  maxTokens?: number;
  overlapTokens?: number;
}

const CHARS_PER_TOKEN = 4;

const isHeading = (line: string): boolean => {
  const t = line.trim();
  if (!t || t.length > 90) return false;
  if (/^#{1,6}\s+\S/.test(t)) return true;
  if (/^\d+(\.\d+)*[.)]?\s+\p{Lu}/u.test(t) && !/[.;,]$/.test(t)) return true;
  const letters = t.replace(/[^\p{L}]/gu, '');
  return letters.length >= 4 && letters === letters.toUpperCase() && !/[.;,]$/.test(t);
};

const splitSentences = (text: string): string[] =>
  text.split(/(?<=[.!?])\s+(?=\p{Lu}|\d)/u).map((s) => s.trim()).filter(Boolean);

/** Quebra um parágrafo grande demais em pedaços de até `maxChars`, respeitando frases. */
const splitLong = (paragraph: string, maxChars: number): string[] => {
  if (paragraph.length <= maxChars) return [paragraph];
  const out: string[] = [];
  let cur = '';
  for (const sentence of splitSentences(paragraph)) {
    if (sentence.length > maxChars) {
      if (cur) out.push(cur), (cur = '');
      for (let i = 0; i < sentence.length; i += maxChars) out.push(sentence.slice(i, i + maxChars));
      continue;
    }
    if ((cur + ' ' + sentence).trim().length > maxChars) out.push(cur), (cur = sentence);
    else cur = (cur + ' ' + sentence).trim();
  }
  if (cur) out.push(cur);
  return out;
};

/** Últimas frases de `text` somando até `maxChars`, para sobreposição entre chunks. */
const tailOverlap = (text: string, maxChars: number): string => {
  if (maxChars <= 0) return '';
  const sentences = splitSentences(text);
  let acc = '';
  for (let i = sentences.length - 1; i >= 0; i--) {
    const next = sentences[i] + (acc ? ' ' + acc : '');
    if (next.length > maxChars) break;
    acc = next;
  }
  return acc;
};

/**
 * Chunking por títulos/parágrafos (doc 03 §1): ~500–800 tokens com sobreposição ~80.
 * Cada título inicia uma nova seção; o título fica no `section` e no início do conteúdo.
 */
export function chunkText(text: string, page?: number, opts: ChunkOptions = {}): RawChunk[] {
  const target = (opts.targetTokens ?? 650) * CHARS_PER_TOKEN;
  const max = (opts.maxTokens ?? 800) * CHARS_PER_TOKEN;
  const overlap = (opts.overlapTokens ?? 80) * CHARS_PER_TOKEN;

  const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const chunks: RawChunk[] = [];
  let section: string | undefined;
  let buf = '';
  let bufSection: string | undefined;

  const flush = (keepOverlap: boolean) => {
    const content = buf.trim();
    if (content) chunks.push({ content, section: bufSection, page });
    buf = keepOverlap ? tailOverlap(content, overlap) : '';
    bufSection = section;
  };

  for (const block of blocks) {
    const [first = '', ...rest] = block.split('\n');
    if (isHeading(first) && rest.length === 0) {
      flush(false); // novo título: não carrega sobreposição entre seções
      section = first.replace(/^#{1,6}\s+/, '').trim();
      bufSection = section;
      buf = section;
      continue;
    }
    for (const piece of splitLong(block, max)) {
      if (buf && (buf + '\n\n' + piece).length > target) flush(true);
      buf = buf ? buf + '\n\n' + piece : piece;
      bufSection ??= section;
    }
  }
  flush(false);
  return chunks.filter((c) => c.content.length > 0);
}

/** FAQ: um chunk por par pergunta/resposta (doc 03 §1). */
export const faqChunk = (question: string, answer: string): RawChunk => ({
  content: `Pergunta: ${question.trim()}\nResposta: ${answer.trim()}`,
  section: question.trim(),
});
