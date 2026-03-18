/**
 * Web Tools — Search and fetch web content.
 */

import type { ActionResult, ToolDefinition } from '../types/index.js';
import { PermissionLevel } from '../types/index.js';

export const webSearchDef: ToolDefinition = {
  name: 'web_search',
  description: 'Search the web for information using a query string.',
  parameters: {
    query: { type: 'string', description: 'Search query', required: true },
  },
  permissionLevel: PermissionLevel.FREE,
};

export const webFetchDef: ToolDefinition = {
  name: 'web_fetch',
  description: 'Fetch a web page and return its text content.',
  parameters: {
    url: { type: 'string', description: 'URL to fetch', required: true },
  },
  permissionLevel: PermissionLevel.FREE,
};

export async function webSearchExecutor(args: Record<string, unknown>): Promise<ActionResult> {
  const query = String(args.query ?? '');
  try {
    // Use a simple search API — this is a placeholder that can be swapped
    // for any search provider (SerpAPI, Brave Search, etc.)
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NewClaw/0.1' },
    });
    const html = await response.text();

    // Extract simple text snippets from results
    const snippets = html
      .match(/class="result__snippet">(.*?)<\//gs)
      ?.map((s) => s.replace(/<[^>]+>/g, '').replace('class="result__snippet">', ''))
      .slice(0, 5)
      ?? ['No results found.'];

    return { tool: 'web_search', success: true, output: snippets.join('\n\n') };
  } catch (err) {
    return { tool: 'web_search', success: false, output: '', error: String(err) };
  }
}

export async function webFetchExecutor(args: Record<string, unknown>): Promise<ActionResult> {
  const url = String(args.url ?? '');
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'NewClaw/0.1' },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();

    // Strip HTML tags for readability, limit output
    const cleaned = text
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 10_000);

    return { tool: 'web_fetch', success: true, output: cleaned };
  } catch (err) {
    return { tool: 'web_fetch', success: false, output: '', error: String(err) };
  }
}
