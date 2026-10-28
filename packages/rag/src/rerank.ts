import { tokenize } from './embeddings';
import type { Reranker, SearchHit } from './types';

/**
 * Rerank leve (decisão D-008): combina a pontuação RRF normalizada com a fração de termos
 * da consulta presentes no trecho. Não é um modelo de reranking; a interface `Reranker`
 * permite trocá-lo depois.
 */
export class LexicalReranker implements Reranker {
  rerank(query: string, hits: SearchHit[]): SearchHit[] {
    if (!hits.length) return hits;
    const terms = [...new Set(tokenize(query))];
    const maxRrf = Math.max(...hits.map((h) => h.score)) || 1;
    return hits
      .map((h) => {
        const text = new Set(tokenize(h.content));
        const overlap = terms.length ? terms.filter((t) => text.has(t)).length / terms.length : 0;
        return { ...h, score: 0.6 * (h.score / maxRrf) + 0.4 * overlap };
      })
      .sort((a, b) => b.score - a.score);
  }
}
