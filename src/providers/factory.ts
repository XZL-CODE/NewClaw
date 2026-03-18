/**
 * Provider Factory — Create the right LLM provider from configuration.
 *
 * Preset registry covers all major providers. Users can also specify
 * a custom baseUrl for any OpenAI-compatible endpoint.
 */

import type { LLMProvider, ProviderConfig } from './types.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

// ============================================================
// Preset Provider Registry
// ============================================================

interface PresetEntry {
  type: 'anthropic' | 'openai-compatible';
  baseUrl?: string;
  defaultApiKey?: string;  // For local providers that don't need real keys
  envKey?: string;         // Environment variable name for API key
}

export const PRESET_PROVIDERS: Record<string, PresetEntry> = {
  anthropic: {
    type: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
  },
  openai: {
    type: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY',
  },
  deepseek: {
    type: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY',
  },
  moonshot: {
    type: 'openai-compatible',
    baseUrl: 'https://api.moonshot.ai/v1',
    envKey: 'MOONSHOT_API_KEY',
  },
  dashscope: {
    type: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envKey: 'DASHSCOPE_API_KEY',
  },
  zhipu: {
    type: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
    envKey: 'ZAI_API_KEY',
  },
  gemini: {
    type: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    envKey: 'GEMINI_API_KEY',
  },
  ollama: {
    type: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    defaultApiKey: 'ollama',
  },
  lmstudio: {
    type: 'openai-compatible',
    baseUrl: 'http://localhost:1234/v1',
    defaultApiKey: 'lmstudio',
  },
  vllm: {
    type: 'openai-compatible',
    baseUrl: 'http://localhost:8000/v1',
    defaultApiKey: 'vllm',
  },
  openrouter: {
    type: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
  },
  siliconflow: {
    type: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    envKey: 'SILICONFLOW_API_KEY',
  },
};

// ============================================================
// Factory
// ============================================================

export function createProvider(config: ProviderConfig): LLMProvider {
  const preset = PRESET_PROVIDERS[config.provider];

  // Anthropic — use native SDK
  if (config.provider === 'anthropic' || preset?.type === 'anthropic') {
    return new AnthropicProvider(config.apiKey, config.baseUrl);
  }

  // OpenAI-compatible — resolve baseUrl from preset or config
  const baseUrl = config.baseUrl ?? preset?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `Provider "${config.provider}" has no preset baseUrl. ` +
      `Please specify baseUrl in your config or use a known provider name.`,
    );
  }

  const apiKey = config.apiKey || preset?.defaultApiKey || '';
  return new OpenAICompatibleProvider(config.provider, baseUrl, apiKey);
}

/** Auto-detect provider from available environment variables. */
export function detectProviderFromEnv(): Partial<ProviderConfig> | null {
  // Check in priority order
  const checks: Array<{ envKey: string; provider: string; defaultModel: string }> = [
    { envKey: 'ANTHROPIC_API_KEY', provider: 'anthropic', defaultModel: 'claude-sonnet-4-20250514' },
    { envKey: 'OPENAI_API_KEY', provider: 'openai', defaultModel: 'gpt-4o' },
    { envKey: 'DEEPSEEK_API_KEY', provider: 'deepseek', defaultModel: 'deepseek-chat' },
    { envKey: 'MOONSHOT_API_KEY', provider: 'moonshot', defaultModel: 'kimi-latest' },
    { envKey: 'DASHSCOPE_API_KEY', provider: 'dashscope', defaultModel: 'qwen-plus' },
    { envKey: 'ZAI_API_KEY', provider: 'zhipu', defaultModel: 'glm-4-plus' },
    { envKey: 'GEMINI_API_KEY', provider: 'gemini', defaultModel: 'gemini-2.5-flash' },
    { envKey: 'OPENROUTER_API_KEY', provider: 'openrouter', defaultModel: 'anthropic/claude-sonnet-4-20250514' },
    { envKey: 'SILICONFLOW_API_KEY', provider: 'siliconflow', defaultModel: 'Qwen/Qwen2.5-72B-Instruct' },
  ];

  for (const { envKey, provider, defaultModel } of checks) {
    const key = process.env[envKey];
    if (key) {
      return { provider, apiKey: key, model: defaultModel };
    }
  }

  return null;
}
