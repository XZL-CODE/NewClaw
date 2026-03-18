/**
 * Configuration Loader — Load from file, env vars, or defaults.
 *
 * Supports multi-provider config via NEWCLAW_PROVIDER, NEWCLAW_API_KEY, etc.
 * Auto-detects provider from available API key environment variables.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { NewClawConfig, ChannelConfig, PermissionConfig } from '../types/index.js';
import { DEFAULT_PERSONA, DEFAULT_USER_PROFILE } from './default-persona.js';
import { detectProviderFromEnv } from '../providers/factory.js';

// Project-relative: newClaw/config.json (alongside package.json)
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = join(PROJECT_ROOT, 'config.json');

const DEFAULT_PERMISSIONS: PermissionConfig = {
  approvalRequired: ['send_message'],
  forbidden: [],
  autoApproveAll: false,
};

const DEFAULT_CHANNELS: ChannelConfig[] = [
  { type: 'terminal', enabled: true },
];

export function loadConfig(configPath?: string): NewClawConfig {
  const path = configPath ?? DEFAULT_CONFIG_PATH;
  let fileConfig: Partial<NewClawConfig> = {};

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      fileConfig = JSON.parse(raw);
    } catch {
      // Logger not yet initialized here — use console.warn for bootstrap errors
      console.warn(`Warning: Could not parse config at ${path}, using defaults.`);
    }
  }

  // Auto-detect provider from environment variables
  const detected = detectProviderFromEnv();

  // Environment variables override file config, with auto-detection as fallback
  const provider = env('NEWCLAW_PROVIDER') ?? fileConfig.provider ?? detected?.provider ?? 'anthropic';
  const apiKey = env('NEWCLAW_API_KEY') ?? env('ANTHROPIC_API_KEY') ?? fileConfig.apiKey ?? detected?.apiKey ?? '';
  const model = env('NEWCLAW_MODEL') ?? fileConfig.model ?? detected?.model ?? 'claude-sonnet-4-20250514';

  const config: NewClawConfig = {
    provider,
    apiKey,
    model,
    maxTokens: num(env('NEWCLAW_MAX_TOKENS')) ?? fileConfig.maxTokens ?? 8192,
    baseUrl: env('NEWCLAW_BASE_URL') ?? fileConfig.baseUrl,

    persona: fileConfig.persona ?? DEFAULT_PERSONA,
    userProfile: fileConfig.userProfile ?? DEFAULT_USER_PROFILE,

    channels: fileConfig.channels ?? DEFAULT_CHANNELS,
    memoryDbPath: resolveProjectPath(env('NEWCLAW_MEMORY_DB') ?? fileConfig.memoryDbPath ?? join(PROJECT_ROOT, 'data', 'memory.db')),
    permissions: fileConfig.permissions ?? DEFAULT_PERMISSIONS,
    webhookPort: num(env('NEWCLAW_WEBHOOK_PORT')) ?? fileConfig.webhookPort ?? 0,
    webPort: num(env('NEWCLAW_WEB_PORT')) ?? fileConfig.webPort,
    quietHours: fileConfig.quietHours,
    mcpServers: fileConfig.mcpServers,
  };

  // Inject tokens from env into channel configs
  for (const ch of config.channels) {
    if (ch.type === 'telegram' && !ch.token) {
      ch.token = env('TELEGRAM_TOKEN');
    }
    if (ch.type === 'discord' && !ch.token) {
      ch.token = env('DISCORD_TOKEN');
    }
  }

  return config;
}

/** Resolve relative paths against PROJECT_ROOT, not process.cwd() */
function resolveProjectPath(p: string): string {
  return p.startsWith('/') ? p : join(PROJECT_ROOT, p);
}

function env(key: string): string | undefined {
  return process.env[key] || undefined;
}

function num(val: string | undefined): number | undefined {
  if (!val) return undefined;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}
