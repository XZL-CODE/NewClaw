/**
 * DiscordChannel — Discord Bot adapter using discord.js.
 */

import { Client, GatewayIntentBits } from 'discord.js';
import { randomUUID } from 'crypto';
import type { ChannelAdapter, NewClawEvent } from '../types/index.js';

export class DiscordChannel implements ChannelAdapter {
  readonly name = 'discord';
  private client: Client;
  private handler: ((event: NewClawEvent) => void) | null = null;
  private token: string;

  constructor(token: string) {
    this.token = token;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  async connect(): Promise<void> {
    this.client.on('messageCreate', (message) => {
      // Ignore bot's own messages
      if (message.author.bot) return;
      if (!this.handler) return;

      const event: NewClawEvent = {
        id: randomUUID(),
        source: 'user',
        channel: 'discord',
        timestamp: Date.now(),
        data: {
          text: message.content,
          channelId: message.channelId,
          userId: message.author.id,
          username: message.author.username,
          isDM: message.channel.isDMBased(),
        },
        priority: 'normal',
      };
      this.handler(event);
    });

    await this.client.login(this.token);
  }

  async disconnect(): Promise<void> {
    await this.client.destroy();
  }

  async sendMessage(to: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(to);
    if (channel && channel.isTextBased() && 'send' in channel) {
      await (channel as { send: (content: string) => Promise<unknown> }).send(content);
    }
  }

  onMessage(handler: (event: NewClawEvent) => void): void {
    this.handler = handler;
  }
}
