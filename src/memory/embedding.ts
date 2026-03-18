/**
 * Embedding Service
 *
 * Pragmatic approach: local BM25/TF-IDF for semantic matching.
 * No external API dependency — works offline, zero latency.
 *
 * The FTS5 in SQLite already handles BM25 ranking natively,
 * so this module provides a lightweight TF-IDF vector space
 * for cosine similarity when we need cross-document comparison
 * (e.g., deduplication in compact()).
 */

export class EmbeddingService {
  private idfCache: Map<string, number> = new Map();
  private documentCount = 0;
  private documentFrequency: Map<string, number> = new Map();

  /** Tokenize text into normalized terms */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);
  }

  /** Compute term frequency map */
  private termFrequency(tokens: string[]): Map<string, number> {
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    // Normalize by document length
    const len = tokens.length || 1;
    for (const [term, count] of tf) {
      tf.set(term, count / len);
    }
    return tf;
  }

  /** Update IDF statistics with a new document */
  addDocument(text: string): void {
    this.documentCount++;
    const uniqueTerms = new Set(this.tokenize(text));
    for (const term of uniqueTerms) {
      this.documentFrequency.set(term, (this.documentFrequency.get(term) || 0) + 1);
    }
    this.idfCache.clear(); // Invalidate cache
  }

  /** Remove a document's contribution to IDF statistics */
  removeDocument(text: string): void {
    if (this.documentCount <= 0) return;
    this.documentCount--;
    const uniqueTerms = new Set(this.tokenize(text));
    for (const term of uniqueTerms) {
      const count = (this.documentFrequency.get(term) || 1) - 1;
      if (count <= 0) {
        this.documentFrequency.delete(term);
      } else {
        this.documentFrequency.set(term, count);
      }
    }
    this.idfCache.clear();
  }

  /** Get IDF for a term */
  private idf(term: string): number {
    let cached = this.idfCache.get(term);
    if (cached !== undefined) return cached;

    const df = this.documentFrequency.get(term) || 0;
    const totalDocs = Math.max(this.documentCount, 1);
    // Smoothed IDF: log(1 + N / (1 + df))
    cached = Math.log(1 + totalDocs / (1 + df));
    this.idfCache.set(term, cached);
    return cached;
  }

  /** Generate a sparse TF-IDF vector as a flat number array (sorted by term for consistency) */
  generateEmbedding(text: string): number[] {
    const tokens = this.tokenize(text);
    const tf = this.termFrequency(tokens);
    const allTerms = Array.from(this.documentFrequency.keys()).sort();

    // Create dense vector over all known terms
    const vector: number[] = new Array(allTerms.length).fill(0);
    for (let i = 0; i < allTerms.length; i++) {
      const term = allTerms[i];
      const tfVal = tf.get(term) || 0;
      if (tfVal > 0) {
        vector[i] = tfVal * this.idf(term);
      }
    }
    return vector;
  }

  /** Generate embeddings for multiple texts */
  generateEmbeddings(texts: string[]): number[][] {
    return texts.map(t => this.generateEmbedding(t));
  }

  /** Cosine similarity between two vectors */
  cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < len; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  /** Quick similarity check between two texts (no pre-computed embeddings needed) */
  textSimilarity(textA: string, textB: string): number {
    const tokensA = new Set(this.tokenize(textA));
    const tokensB = new Set(this.tokenize(textB));
    if (tokensA.size === 0 || tokensB.size === 0) return 0;

    let intersection = 0;
    for (const t of tokensA) {
      if (tokensB.has(t)) intersection++;
    }

    // Jaccard similarity — simple, fast, good enough for dedup detection
    return intersection / (tokensA.size + tokensB.size - intersection);
  }

  /** Get vocabulary size (useful for stats) */
  get vocabularySize(): number {
    return this.documentFrequency.size;
  }
}
