import type { EmbeddingProvider } from './types';

const STOPWORDS = new Set(
  'a o as os um uma uns umas de do da dos das em no na nos nas por para com sem e ou que se ao aos à às é são foi ser the of and to in'.split(' '),
);

export const normalizeText = (s: string): string =>
  s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');

export const tokenize = (s: string): string[] =>
  normalizeText(s).split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));

const fnv1a = (str: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/**
 * Embeddings determinísticos por *feature hashing* de palavras e bigramas.
 * Captura apenas sobreposição lexical — SEM semântica real. Existe para testes e
 * desenvolvimento offline (decisão D-009); não use em produção.
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'hash-384-v1';
  readonly dimensions = 384;

  private embed(text: string): Float32Array {
    const v = new Float32Array(this.dimensions);
    const tokens = tokenize(text);
    const add = (feature: string, weight: number) => {
      const h = fnv1a(feature);
      v[h % this.dimensions]! += (h & 0x80000000) === 0 ? weight : -weight;
    };
    tokens.forEach((t, i) => {
      add(t, 1);
      if (i > 0) add(`${tokens[i - 1]}_${t}`, 0.5);
    });
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return v;
  }

  async embedQuery(text: string) {
    return this.embed(text);
  }
  async embedPassages(texts: string[]) {
    return texts.map((t) => this.embed(t));
  }
}

type Extractor = (input: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;

/**
 * Embeddings locais via Transformers.js (ONNX, sem GPU). Carrega sob demanda; o modelo
 * é baixado na primeira execução (exige rede). Padrão: multilingual-e5-small (384 dim).
 * O E5 exige prefixos "query: " / "passage: ".
 */
export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 384;
  readonly id: string;
  private extractor?: Promise<Extractor>;

  constructor(
    private readonly model = 'Xenova/multilingual-e5-small',
    private readonly cacheDir?: string,
  ) {
    this.id = model;
  }

  private load(): Promise<Extractor> {
    this.extractor ??= (async () => {
      // @ts-ignore pacote opcional: pode não estar instalado
      const mod = await import('@huggingface/transformers').catch(() => {
        throw new Error('Pacote opcional "@huggingface/transformers" não está instalado.');
      });
      if (this.cacheDir) mod.env.cacheDir = this.cacheDir;
      return (await mod.pipeline('feature-extraction', this.model)) as unknown as Extractor;
    })();
    return this.extractor;
  }

  private async run(texts: string[]): Promise<Float32Array[]> {
    const ex = await this.load();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const res = await ex(texts.slice(i, i + 16), { pooling: 'mean', normalize: true });
      for (const row of res.tolist()) out.push(Float32Array.from(row));
    }
    return out;
  }

  async embedQuery(text: string) {
    return (await this.run([`query: ${text}`]))[0]!;
  }
  async embedPassages(texts: string[]) {
    return this.run(texts.map((t) => `passage: ${t}`));
  }
}
