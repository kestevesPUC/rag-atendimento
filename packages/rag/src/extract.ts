/// <reference path="./modules.d.ts" />
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export interface ExtractedSection {
  text: string;
  page?: number;
}
export interface ExtractedDocument {
  title?: string;
  sections: ExtractedSection[];
}

export type DocType = 'pdf' | 'docx' | 'txt' | 'md';

export const detectDocType = (filename: string): DocType | null => {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === 'pdf' || ext === 'docx' || ext === 'txt' || ext === 'md' ? ext : null;
};

const clean = (s: string): string =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

export async function extractFromBuffer(buf: Buffer, type: DocType): Promise<ExtractedDocument> {
  switch (type) {
    case 'txt':
    case 'md':
      return { sections: [{ text: clean(buf.toString('utf8')) }] };
    case 'docx': {
      const mammoth = await import('mammoth');
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return { sections: [{ text: clean(value) }] };
    }
    case 'pdf': {
      // Importa o módulo interno: o index do pdf-parse tenta ler um arquivo de teste ao ser carregado.
      const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
      const sections: ExtractedSection[] = [];
      await pdfParse(buf, {
        pagerender: async (page: { getTextContent(): Promise<{ items: { str: string; transform: number[] }[] }> }) => {
          const content = await page.getTextContent();
          let lastY: number | undefined;
          let text = '';
          for (const item of content.items) {
            const y = item.transform[5];
            text += lastY === undefined || lastY === y ? item.str : '\n' + item.str;
            lastY = y;
          }
          sections.push({ text: clean(text), page: sections.length + 1 });
          return text;
        },
      });
      return { sections: sections.filter((s) => s.text) };
    }
  }
}

const MAX_URL_BYTES = 5 * 1024 * 1024;

const isPrivateAddress = (ip: string): boolean =>
  /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(ip) ||
  /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
  ip === '::1' ||
  /^f[cd]/i.test(ip) ||
  /^fe80/i.test(ip);

/** Bloqueia destinos internos (inclui o endpoint de metadados de nuvem 169.254.169.254). Decisão D-012. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Somente URLs http(s) são permitidas.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.some(isPrivateAddress)) throw new Error('URL aponta para um endereço interno; importação bloqueada.');
  return url;
}

export async function extractFromUrl(raw: string, fetchImpl: typeof fetch = fetch): Promise<ExtractedDocument> {
  const url = await assertPublicUrl(raw);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), redirect: 'error', headers: { 'user-agent': 'RagAtendimento/0.1' } });
  if (!res.ok) throw new Error(`A URL respondeu ${res.status}.`);
  const html = await res.text();
  if (html.length > MAX_URL_BYTES) throw new Error('Página grande demais (limite de 5 MB).');

  const { parseHTML } = await import('linkedom');
  const { Readability } = await import('@mozilla/readability');
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  const text = clean(article?.textContent ?? document.body?.textContent ?? '');
  if (!text) throw new Error('Não foi possível extrair texto da página.');
  return { title: article?.title || url.hostname, sections: [{ text }] };
}
