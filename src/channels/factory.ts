/**
 * Channel Factory — Create channel adapters from config.
 *
 * Centralizes channel initialization logic so index.ts doesn't need
 * to know about individual channel implementations.
 */

import type { ChannelAdapter, ChannelConfig } from '../types/index.js';
import { TerminalChannel } from './terminal.js';
import { TelegramChannel } from './telegram.js';
import { DiscordChannel } from './discord.js';
import { FeishuChannel } from './feishu.js';
import { WebChannel } from './web.js';
import { logger } from '../core/logger.js';

/**
 * Create a ChannelAdapter from config. Returns null if config is invalid.
 */
export function createChannel(config: ChannelConfig): ChannelAdapter | null {
  switch (config.type) {
    case 'terminal':
      return new TerminalChannel();

    case 'telegram':
      if (!config.token) {
        logger.warn('ChannelFactory', 'Telegram channel enabled but no token provided, skipping.');
        return null;
      }
      return new TelegramChannel(config.token);

    case 'discord':
      if (!config.token) {
        logger.warn('ChannelFactory', 'Discord channel enabled but no token provided, skipping.');
        return null;
      }
      return new DiscordChannel(config.token);

    case 'feishu': {
      const appId = config.options?.appId as string;
      const appSecret = config.options?.appSecret as string;
      if (!appId || !appSecret) {
        logger.warn('ChannelFactory', 'Feishu channel enabled but appId/appSecret not provided, skipping.');
        return null;
      }
      return new FeishuChannel(appId, appSecret);
    }

    case 'web': {
      const port = (config.options?.port as number) ?? 3210;
      return new WebChannel(port);
    }

    default:
      logger.warn('ChannelFactory', `Unknown channel type: ${config.type}, skipping.`);
      return null;
  }
}

/**
 * Create all enabled channels from config array.
 */
export function createAllChannels(configs: ChannelConfig[]): Map<string, ChannelAdapter> {
  const channels = new Map<string, ChannelAdapter>();
  for (const cfg of configs) {
    if (!cfg.enabled) continue;
    const channel = createChannel(cfg);
    if (channel) {
      channels.set(channel.name, channel);
    }
  }
  return channels;
}
