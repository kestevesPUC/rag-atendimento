import { chunkText, faqChunk } from './chunker';
import type { ExtractedDocument } from './extract';
import type { ChunkInput } from './types';

/** Converte um documento extraído em chunks com metadados (doc 03 §1). */
export function chunksFromDocument(
  documentId: string,
  title: string,
  doc: ExtractedDocument,
  sectorIds: string[],
): ChunkInput[] {
  return doc.sections.flatMap((s) =>
    chunkText(s.text, s.page).map((c) => ({
      documentId,
      sectorIds,
      content: c.content,
      metadata: { title, section: c.section, page: c.page, kind: 'text' as const },
    })),
  );
}

export function chunkFromFaq(documentId: string, question: string, answer: string, sectorIds: string[]): ChunkInput {
  const c = faqChunk(question, answer);
  return { documentId, sectorIds, content: c.content, metadata: { title: question, section: c.section, kind: 'faq' } };
}
