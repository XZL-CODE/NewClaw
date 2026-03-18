/**
 * Memory Tool — Let the model autonomously read and write memories.
 *
 * The model decides what's worth remembering and what to recall.
 */

import type { ActionResult, MemoryItem, MemoryLayer, MemoryQuery, ToolDefinition } from '../types/index.js';
import { PermissionLevel } from '../types/index.js';

export const memoryReadDef: ToolDefinition = {
  name: 'memory_read',
  description: 'Search memories by semantic query. Returns relevant memories sorted by relevance.',
  parameters: {
    query: { type: 'string', description: 'What to search for in memory', required: true },
    layer: { type: 'string', description: 'Filter by memory layer: fact, episode, or reflection' },
    limit: { type: 'number', description: 'Max results to return (default 10)' },
  },
  permissionLevel: PermissionLevel.FREE,
};

export const memoryWriteDef: ToolDefinition = {
  name: 'memory_write',
  description: 'Store a new memory. The model decides what is worth remembering.',
  parameters: {
    layer: { type: 'string', description: 'Memory layer: fact, episode, or reflection', required: true },
    content: { type: 'string', description: 'What to remember', required: true },
    tags: { type: 'string', description: 'Comma-separated tags for categorization' },
  },
  permissionLevel: PermissionLevel.NOTIFY,
};

/** Interface for memory operations — matches MemoryService.query() and .store() */
export interface MemoryServiceForTools {
  query(q: MemoryQuery): MemoryItem[] | Promise<MemoryItem[]>;
  store(layer: MemoryLayer, content: string, tags: string[]): string | Promise<string>;
}

export function createMemoryReadExecutor(
  memoryService: MemoryServiceForTools,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const query = String(args.query ?? '');
    const layer = args.layer ? (String(args.layer) as MemoryLayer) : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 10;

    try {
      const results = await memoryService.query({ text: query, layer, limit });
      if (results.length === 0) {
        return { tool: 'memory_read', success: true, output: 'No relevant memories found.' };
      }

      const formatted = results.map((m) =>
        `[${m.layer}] (relevance: ${m.relevanceScore?.toFixed(2) ?? '?'}) ${m.content}`
      ).join('\n\n');

      return { tool: 'memory_read', success: true, output: formatted };
    } catch (err) {
      return { tool: 'memory_read', success: false, output: '', error: String(err) };
    }
  };
}

export function createMemoryWriteExecutor(
  memoryService: MemoryServiceForTools,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const layer = String(args.layer ?? 'fact') as MemoryLayer;
    const content = String(args.content ?? '');
    const tags = args.tags
      ? String(args.tags).split(',').map((t) => t.trim())
      : [];

    try {
      const id = await memoryService.store(layer, content, tags);
      return {
        tool: 'memory_write',
        success: true,
        output: `Memory stored (id: ${id}, layer: ${layer})`,
      };
    } catch (err) {
      return { tool: 'memory_write', success: false, output: '', error: String(err) };
    }
  };
}
