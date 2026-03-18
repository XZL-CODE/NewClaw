/**
 * Self-Reflection Module
 *
 * Inspired by Generative Agents: periodically review recent episodes
 * and generate higher-order insights (reflections).
 *
 * When an LLM call function is provided, uses the model to generate
 * genuine high-level insights. Falls back to TF-IDF + template otherwise.
 */

import type { MemoryItem } from '../types/index.js';

interface MemoryServiceForReflection {
  getRecent(layer: 'episode', limit: number): MemoryItem[];
  addReflection(content: string, tags: string[]): MemoryItem;
}

/** Extract top keywords from a set of texts using simple term frequency. */
function extractKeywords(texts: string[], topN = 10): string[] {
  const termFreq = new Map<string, number>();
  const stopWords = new Set([
    // Common Chinese stop words
    '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
    '自己', '这', '他', '她', '它', '们', '那', '些', '什么', '怎么', '如何',
    // Common English stop words
    'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 'but', 'in',
    'with', 'to', 'for', 'of', 'not', 'no', 'can', 'had', 'have', 'was',
    'were', 'been', 'be', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'this', 'that', 'these', 'those',
    'it', 'its', 'from', 'by', 'as', 'are', 'has', 'he', 'she', 'they',
    // Meta/system words
    'system', 'user', 'assistant', 'tool', 'auto', 'summary',
  ]);

  for (const text of texts) {
    const tokens = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !stopWords.has(t));

    for (const token of tokens) {
      termFreq.set(token, (termFreq.get(token) || 0) + 1);
    }
  }

  return Array.from(termFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([term]) => term);
}

/** Build a reflection prompt from episode contents for the LLM. */
function buildReflectionPrompt(episodes: MemoryItem[]): string {
  const episodeTexts = episodes.map(ep => ep.content).join('\n---\n');
  return [
    '你是一个记忆管理者。请回顾以下最近的对话记录片段，提炼出 2-3 条高阶洞见。',
    '',
    '洞见应该是：',
    '- 跨多次对话的模式或规律（不是单次事件的复述）',
    '- 对用户行为偏好、工作习惯、关注领域的深层理解',
    '- 可以指导未来交互策略的认知',
    '',
    '对话记录：',
    '---',
    episodeTexts,
    '---',
    '',
    '请直接输出洞见，每条一行，不需要编号或前缀。简洁有力，每条不超过 50 字。',
  ].join('\n');
}

/**
 * Trigger a self-reflection cycle.
 *
 * When `llmCall` is provided, uses the LLM to generate genuine high-level insights.
 * Otherwise falls back to TF-IDF keyword extraction + template-based reflection.
 */
export async function triggerReflection(
  memoryService: MemoryServiceForReflection,
  episodeLimit = 20,
  llmCall?: (prompt: string) => Promise<string>,
): Promise<MemoryItem | null> {
  const recentEpisodes = memoryService.getRecent('episode', episodeLimit);
  if (recentEpisodes.length < 5) {
    // Not enough data for meaningful reflection
    return null;
  }

  const texts = recentEpisodes.map(ep => ep.content);
  const keywords = extractKeywords(texts, 8);

  if (keywords.length === 0) return null;

  let reflection: string;

  if (llmCall) {
    // LLM-driven reflection: let the model generate genuine insights
    try {
      const prompt = buildReflectionPrompt(recentEpisodes);
      const llmResult = await llmCall(prompt);
      reflection = `[自我反思 ${new Date().toISOString()}]\n${llmResult.trim()}`;
      console.log('[Reflection] Generated LLM-driven reflection');
    } catch (err) {
      console.error('[Reflection] LLM call failed, falling back to template:', err);
      reflection = buildTemplateReflection(recentEpisodes, keywords);
    }
  } else {
    // Fallback: template-based reflection
    reflection = buildTemplateReflection(recentEpisodes, keywords);
  }

  const tags = ['auto-reflection', ...keywords.slice(0, 3)];
  const item = memoryService.addReflection(reflection, tags);
  console.log(`[Reflection] Generated reflection with keywords: ${keywords.join(', ')}`);
  return item;
}

/** Template-based fallback reflection generation (original logic). */
function buildTemplateReflection(episodes: MemoryItem[], keywords: string[]): string {
  const timeRange = formatTimeRange(
    episodes[episodes.length - 1].createdAt,
    episodes[0].createdAt,
  );

  return [
    `[自我反思 ${new Date().toISOString()}]`,
    `回顾最近${episodes.length}条记忆（${timeRange}），`,
    `主要关注的主题：${keywords.join('、')}。`,
    `这些话题反复出现，表明用户近期的核心关注点集中在这些领域。`,
  ].join('');
}

function formatTimeRange(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${fmt(start)} ~ ${fmt(end)}`;
}
