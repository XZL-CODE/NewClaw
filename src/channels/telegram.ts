/**
 * TelegramChannel — Telegram Bot adapter using grammy.
 */

import { Bot } from 'grammy';
import { randomUUID } from 'crypto';
import type { ChannelAdapter, NewClawEvent } from '../types/index.js';

export class TelegramChannel implements ChannelAdapter {
  readonly name = 'telegram';
  private bot: Bot;
  private handler: ((event: NewClawEvent) => void) | null = null;

  constructor(token: string) {
    this.bot = new Bot(token);
  }

  async connect(): Promise<void> {
    this.bot.on('message:text', (ctx) => {
      if (!this.handler) return;

      const event: NewClawEvent = {
        id: randomUUID(),
        source: 'user',
        channel: 'telegram',
        timestamp: Date.now(),
        data: {
          text: ctx.message.text,
          chatId: String(ctx.chat.id),
          userId: String(ctx.from.id),
          username: ctx.from.username ?? ctx.from.first_name,
        },
        priority: 'normal',
      };
      this.handler(event);
    });

    // Start polling in background (non-blocking)
    this.bot.start();
  }

  async disconnect(): Promise<void> {
    await this.bot.stop();
  }

  async sendMessage(to: string, content: string): Promise<void> {
    await this.bot.api.sendMessage(to, content, { parse_mode: 'Markdown' });
  }

  onMessage(handler: (event: NewClawEvent) => void): void {
    this.handler = handler;
  }
}
