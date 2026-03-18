/**
 * Memory Service
 *
 * Three-layer memory with hybrid retrieval (FTS5 + TF-IDF).
 * The model decides what to remember and when to forget.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { MemoryItem, MemoryLayer, MemoryQuery } from '../types/index.js';
import { initDatabase } from './schema.js';
import { EmbeddingService } from './embedding.js';
import { triggerReflection } from './reflection.js';

interface MemoryRow {
  id: string;
  layer: string;
  content: string;
  tags: string;
  embedding: Buffer | null;
  created_at: number;
  updated_at: number;
  access_count: number;
  user_id: string | null;
}

interface FtsMatchRow {
  id: string;
  rank: number;
}

interface StatsRow {
  layer: string;
  count: number;
  total_size: number;
}

export class MemoryService {
  private db: Database.Database;
  private embedding: EmbeddingService;
  private llmCall?: (prompt: string) => Promise<string>;

  /** Auto-compact threshold: trigger compact() when total memory count exceeds this. */
  autoCompactThreshold = 500;

  // Prepared statements
  private stmtInsert: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtUpdateContent: Database.Statement;
  private stmtUpdateAccess: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtGetRecent: Database.Statement;
  private stmtGetByTags: Database.Statement;
  private stmtGetAll: Database.Statement;
  private stmtFtsSearch: Database.Statement;
  private stmtStats: Database.Statement;
  private stmtCount: Database.Statement;
  private stmtGetByUser: Database.Statement;
  private stmtGetGlobal: Database.Statement;

  constructor(dbPath: string, embeddingService?: EmbeddingService) {
    this.db = initDatabase(dbPath);
    this.embedding = embeddingService ?? new EmbeddingService();

    // Build IDF corpus from existing memories
    const existing = this.db.prepare('SELECT content FROM memories').all() as { content: string }[];
    for (const row of existing) {
      this.embedding.addDocument(row.content);
    }

    // Prepare all statements
    this.stmtInsert = this.db.prepare(`
      INSERT INTO memories (id, layer, content, tags, embedding, created_at, updated_at, access_count, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);

    this.stmtDelete = this.db.prepare('DELETE FROM memories WHERE id = ?');

    this.stmtUpdateContent = this.db.prepare(`
      UPDATE memories SET content = ?, tags = ?, embedding = ?, updated_at = ? WHERE id = ?
    `);

    this.stmtUpdateAccess = this.db.prepare(`
      UPDATE memories SET access_count = access_count + 1, updated_at = ? WHERE id = ?
    `);

    this.stmtGetById = this.db.prepare('SELECT * FROM memories WHERE id = ?');

    this.stmtGetRecent = this.db.prepare(`
      SELECT * FROM memories WHERE layer = ? ORDER BY created_at DESC LIMIT ?
    `);

    this.stmtGetByTags = this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC');

    this.stmtGetAll = this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC');

    this.stmtFtsSearch = this.db.prepare(`
      SELECT m.id, rank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    this.stmtStats = this.db.prepare(`
      SELECT layer, COUNT(*) as count, SUM(LENGTH(content)) as total_size
      FROM memories GROUP BY layer
    `);

    this.stmtCount = this.db.prepare('SELECT COUNT(*) as count FROM memories');

    this.stmtGetByUser = this.db.prepare(
      'SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC'
    );

    this.stmtGetGlobal = this.db.prepare(
      'SELECT * FROM memories WHERE user_id IS NULL ORDER BY updated_at DESC'
    );
  }

  // ── Write API ──────────────────────────────────────────────

  addFact(content: string, tags: string[] = [], userId?: string): MemoryItem {
    return this.add('fact', content, tags, userId);
  }

  addEpisode(content: string, tags: string[] = [], userId?: string): MemoryItem {
    return this.add('episode', content, tags, userId);
  }

  addReflection(content: string, tags: string[] = [], userId?: string): MemoryItem {
    return this.add('reflection', content, tags, userId);
  }

  private add(layer: MemoryLayer, content: string, tags: string[], userId?: string): MemoryItem {
    const id = randomUUID();
    const now = Date.now();

    this.embedding.addDocument(content);
    const vector = this.embedding.generateEmbedding(content);
    const embeddingBlob = Buffer.from(new Float64Array(vector).buffer);

    this.stmtInsert.run(id, layer, content, JSON.stringify(tags), embeddingBlob, now, now, userId ?? null);

    // Auto-compact check (fire-and-forget, does not block add())
    void this.checkAutoCompact();

    return {
      id,
      layer,
      content,
      tags,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
    };
  }

  // ── Read API ───────────────────────────────────────────────

  search(query: MemoryQuery, userId?: string): MemoryItem[] {
    const limit = query.limit ?? 10;
    const minRelevance = query.minRelevance ?? 0;

    // Step 1: FTS5 keyword search
    const ftsResults = new Map<string, number>();
    try {
      const ftsQuery = this.buildFtsQuery(query.text);
      if (ftsQuery) {
        const rows = this.stmtFtsSearch.all(ftsQuery, limit * 3) as FtsMatchRow[];
        for (const row of rows) {
          ftsResults.set(row.id, Math.min(1, Math.abs(row.rank)));
        }
      }
    } catch {
      // FTS query syntax error — fall through to vector search
    }

    // Step 2: Vector similarity search
    // If userId is specified, search user-specific + global memories
    const queryVector = this.embedding.generateEmbedding(query.text);
    let allMemories: MemoryRow[];
    if (userId) {
      const userRows = this.stmtGetByUser.all(userId) as MemoryRow[];
      const globalRows = this.stmtGetGlobal.all() as MemoryRow[];
      // Merge and deduplicate (user memories first for priority)
      const seen = new Set<string>();
      allMemories = [];
      for (const row of [...userRows, ...globalRows]) {
        if (!seen.has(row.id)) {
          seen.add(row.id);
          allMemories.push(row);
        }
      }
    } else {
      allMemories = this.stmtGetAll.all() as MemoryRow[];
    }

    const scored: { row: MemoryRow; score: number }[] = [];

    for (const row of allMemories) {
      if (query.layer && row.layer !== query.layer) continue;

      if (query.tags && query.tags.length > 0) {
        const rowTags: string[] = JSON.parse(row.tags);
        if (!query.tags.some(t => rowTags.includes(t))) continue;
      }

      let vectorScore = 0;
      if (row.embedding && queryVector.length > 0) {
        const storedVector = Array.from(new Float64Array(
          row.embedding.buffer,
          row.embedding.byteOffset,
          row.embedding.byteLength / 8
        ));
        vectorScore = this.embedding.cosineSimilarity(queryVector, storedVector);
      }

      const ftsScore = ftsResults.get(row.id) ?? 0;
      const score = 0.4 * Math.min(ftsScore, 1) + 0.6 * vectorScore;

      if (score >= minRelevance) {
        scored.push({ row, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const topResults = scored.slice(0, limit);

    const updateTransaction = this.db.transaction((items: typeof topResults) => {
      const now = Date.now();
      for (const item of items) {
        this.stmtUpdateAccess.run(now, item.row.id);
      }
    });
    updateTransaction(topResults);

    return topResults.map(({ row, score }) => this.rowToItem(row, score));
  }

  getRecent(layer: MemoryLayer, limit = 10): MemoryItem[] {
    const rows = this.stmtGetRecent.all(layer, limit) as MemoryRow[];
    return rows.map(r => this.rowToItem(r));
  }

  getByTags(tags: string[]): MemoryItem[] {
    const rows = this.stmtGetByTags.all() as MemoryRow[];
    return rows
      .filter(row => {
        const rowTags: string[] = JSON.parse(row.tags);
        return tags.some(t => rowTags.includes(t));
      })
      .map(r => this.rowToItem(r));
  }

  // ── Maintenance API ────────────────────────────────────────

  compact(): { merged: number; removed: number } {
    const allRows = this.stmtGetAll.all() as MemoryRow[];
    const toRemove: string[] = [];
    const processed = new Set<string>();
    let merged = 0;

    for (let i = 0; i < allRows.length; i++) {
      if (processed.has(allRows[i].id)) continue;

      for (let j = i + 1; j < allRows.length; j++) {
        if (processed.has(allRows[j].id)) continue;
        if (allRows[i].layer !== allRows[j].layer) continue;

        const similarity = this.embedding.textSimilarity(
          allRows[i].content,
          allRows[j].content
        );

        // Threshold: >50% overlap means likely duplicate
        if (similarity > 0.5) {
          // Keep the one with higher access count, or the newer one
          const keep = allRows[i].access_count >= allRows[j].access_count ? allRows[i] : allRows[j];
          const discard = keep === allRows[i] ? allRows[j] : allRows[i];

          // Merge content if they're similar but not identical
          if (similarity < 0.9) {
            const mergedContent = `${keep.content}\n---\n${discard.content}`;
            const mergedTags = Array.from(new Set([
              ...JSON.parse(keep.tags) as string[],
              ...JSON.parse(discard.tags) as string[],
            ]));
            this.embedding.removeDocument(keep.content);
            this.embedding.addDocument(mergedContent);
            const vector = this.embedding.generateEmbedding(mergedContent);
            const blob = Buffer.from(new Float64Array(vector).buffer);
            this.stmtUpdateContent.run(
              mergedContent, JSON.stringify(mergedTags), blob, Date.now(), keep.id
            );
            merged++;
          }

          this.embedding.removeDocument(discard.content);
          toRemove.push(discard.id);
          processed.add(discard.id);
        }
      }
    }

    // Delete duplicates in a transaction
    const deleteTransaction = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        this.stmtDelete.run(id);
      }
    });
    deleteTransaction(toRemove);

    return { merged, removed: toRemove.length };
  }

  forget(id: string): boolean {
    const row = this.stmtGetById.get(id) as MemoryRow | undefined;
    if (!row) return false;

    this.embedding.removeDocument(row.content);
    this.stmtDelete.run(id);
    return true;
  }

  updateAccessCount(id: string): void {
    this.stmtUpdateAccess.run(Date.now(), id);
  }

  // ── Stats API ──────────────────────────────────────────────

  getStats(): { layers: Record<string, { count: number; totalSize: number }>; vocabularySize: number } {
    const rows = this.stmtStats.all() as StatsRow[];
    const layers: Record<string, { count: number; totalSize: number }> = {};

    for (const row of rows) {
      layers[row.layer] = { count: row.count, totalSize: row.total_size };
    }

    return { layers, vocabularySize: this.embedding.vocabularySize };
  }

  // ── Helpers ────────────────────────────────────────────────

  private buildFtsQuery(text: string): string {
    // Extract meaningful words, join with OR for broad matching
    const terms = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1);

    if (terms.length === 0) return '';
    return terms.join(' OR ');
  }

  private rowToItem(row: MemoryRow, relevanceScore?: number): MemoryItem {
    return {
      id: row.id,
      layer: row.layer as MemoryLayer,
      content: row.content,
      tags: JSON.parse(row.tags),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accessCount: row.access_count,
      relevanceScore,
    };
  }

  // ── Unified Interface (used by ContextAssembler & Tools) ──

  /** Alias for search() — matches ContextAssembler's MemoryService interface. */
  query(q: MemoryQuery, userId?: string): MemoryItem[] {
    return this.search(q, userId);
  }

  /** Unified store method — matches Tools' MemoryServiceForTools interface. */
  store(layer: MemoryLayer, content: string, tags: string[], userId?: string): string {
    return this.add(layer, content, tags, userId).id;
  }

  /** Get total memory count. */
  getTotalCount(): number {
    return (this.stmtCount.get() as { count: number }).count;
  }

  /** Inject an LLM call function for LLM-driven reflection. */
  setLLMCall(fn: (prompt: string) => Promise<string>): void {
    this.llmCall = fn;
  }

  /** Check if auto-compact should be triggered. Also triggers self-reflection. */
  private async checkAutoCompact(): Promise<void> {
    const count = this.getTotalCount();
    if (count >= this.autoCompactThreshold) {
      console.log(`[Memory] Auto-compact triggered: ${count} memories (threshold: ${this.autoCompactThreshold})`);
      const result = this.compact();
      console.log(`[Memory] Auto-compact result: merged=${result.merged}, removed=${result.removed}`);
      // Trigger self-reflection alongside compact
      await triggerReflection(this, 20, this.llmCall);
    }
  }

  /** Expose the underlying database (for timer persistence, etc.) */
  get database(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}
