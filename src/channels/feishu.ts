/**
 * FeishuChannel — Feishu (Lark) Bot adapter using @larksuiteoapi/node-sdk.
 * Uses WSClient for long-lived WebSocket connection (no public IP needed).
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'crypto';
import type { ChannelAdapter, NewClawEvent } from '../types/index.js';

export class FeishuChannel implements ChannelAdapter {
  readonly name = 'feishu';
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private handler: ((event: NewClawEvent) => void) | null = null;
  private appId: string;

  constructor(appId: string, appSecret: string) {
    this.appId = appId;

    this.client = new Lark.Client({
      appId,
      appSecret,
    });

    this.wsClient = new Lark.WSClient({
      appId,
      appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  async connect(): Promise<void> {
    await this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          if (!this.handler) return;

          const { message, sender } = data;

          // Ignore messages from bots (including self)
          if (sender.sender_type !== 'user') return;

          // In group chat, only respond when bot is mentioned
          if (message.chat_type === 'group') {
            const mentions = message.mentions ?? [];
            // Match by any available identifier: key pattern, name, or id fields
            const mentioned = mentions.length > 0 && mentions.some(
              (m: any) =>
                m.key === '@_all' ||
                m.id?.app_id === this.appId ||
                m.id?.union_id === this.appId ||
                m.id?.open_id === this.appId ||
                m.name === 'NewClaw' ||
                m.name === this.name ||
                m.tenant_key != null  // bot mentions typically have tenant_key
            );
            if (!mentioned) {
              console.log('[Feishu] Group message ignored (no bot mention). Mentions:', JSON.stringify(mentions));
              return;
            }
          }

          // Parse message content — handle text, post (rich text), and other types
          let text = '';
          try {
            const content = JSON.parse(message.content);
            if (message.message_type === 'text') {
              text = content.text || '';
            } else if (message.message_type === 'post') {
              // Rich text: extract plain text from all content nodes
              text = this.extractPostText(content);
            } else if (message.message_type === 'interactive') {
              // Card message: try to extract readable text
              text = JSON.stringify(content);
            } else {
              // image, file, etc. — note the type
              text = `[${message.message_type}消息]`;
            }
          } catch {
            text = message.content || '';
          }

          // Strip @mention tags from text
          if (message.mentions) {
            for (const m of message.mentions) {
              text = text.replace(m.key, '').trim();
            }
          }

          const event: NewClawEvent = {
            id: randomUUID(),
            source: 'user',
            channel: 'feishu',
            timestamp: Date.now(),
            data: {
              text,
              chatId: message.chat_id,
              userId: sender.sender_id?.open_id || '',
              username: sender.sender_id?.user_id || '',
              chatType: message.chat_type,
              messageId: message.message_id,
            },
            priority: 'normal',
          };
          this.handler(event);
        },
      }),
    });
  }

  async disconnect(): Promise<void> {
    // WSClient does not expose a stop method; connection closes on process exit
  }

  async sendMessage(to: string, content: string, format: 'text' | 'card' | 'post' = 'text'): Promise<void> {
    const receiveIdType = this.detectIdType(to);

    let msgType: string;
    let msgContent: string;

    switch (format) {
      case 'post':
        msgType = 'post';
        msgContent = JSON.stringify({
          zh_cn: {
            title: '',
            content: [[{ tag: 'text', text: content }]],
          },
        });
        break;
      case 'card':
        msgType = 'interactive';
        msgContent = JSON.stringify(buildInfoCard('NewClaw', content));
        break;
      default:
        msgType = 'text';
        msgContent = JSON.stringify({ text: content });
    }

    await this.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: to,
        content: msgContent,
        msg_type: msgType,
      },
    });
  }

  /** Send an interactive card message. */
  async sendCard(to: string, card: Record<string, unknown>): Promise<void> {
    const receiveIdType = this.detectIdType(to);
    await this.client.im.v1.message.create({
      params: { receive_id_type: receiveIdType },
      data: {
        receive_id: to,
        content: JSON.stringify(card),
        msg_type: 'interactive',
      },
    });
  }

  /** Send rich messages (cards, posts, etc.) — implements ChannelAdapter.sendRichMessage. */
  async sendRichMessage(to: string, type: string, data: Record<string, unknown>): Promise<void> {
    if (type === 'card') {
      await this.sendCard(to, data);
    } else if (type === 'post') {
      await this.sendMessage(to, String(data.content ?? ''), 'post');
    } else {
      await this.sendMessage(to, JSON.stringify(data));
    }
  }

  onMessage(handler: (event: NewClawEvent) => void): void {
    this.handler = handler;
  }

  /** Auto-detect Feishu receive_id_type from ID prefix. */
  private detectIdType(to: string): 'email' | 'chat_id' | 'open_id' | 'union_id' | 'user_id' {
    if (to.startsWith('ou_')) return 'open_id';
    if (to.startsWith('on_')) return 'union_id';
    return 'chat_id';
  }

  /** Extract plain text from Feishu post (rich text) content structure. */
  private extractPostText(content: any): string {
    const parts: string[] = [];
    // Post format: { "zh_cn": { "title": "...", "content": [[{tag, text}, ...], ...] } }
    const post = content.zh_cn || content.en_us || Object.values(content)[0] as any;
    if (!post) return JSON.stringify(content);

    if (post.title) parts.push(post.title);

    if (Array.isArray(post.content)) {
      for (const line of post.content) {
        if (!Array.isArray(line)) continue;
        const lineText = line
          .map((node: any) => {
            if (node.tag === 'text') return node.text || '';
            if (node.tag === 'a') return `${node.text || ''}(${node.href || ''})`;
            if (node.tag === 'at') return `@${node.user_name || node.user_id || ''}`;
            return '';
          })
          .join('');
        if (lineText) parts.push(lineText);
      }
    }

    return parts.join('\n') || JSON.stringify(content);
  }
}

// ─── Helper functions for building Feishu card messages ──────────

/** Build an info card with title, content, and optional header color. */
export function buildInfoCard(
  title: string,
  content: string,
  color: string = 'blue',
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: color,
    },
    elements: [
      {
        tag: 'markdown',
        content,
      },
    ],
  };
}

/** Build a table card with title, column headers, and row data. */
export function buildTableCard(
  title: string,
  headers: string[],
  rows: string[][],
): Record<string, unknown> {
  // Build markdown table
  const headerRow = '| ' + headers.join(' | ') + ' |';
  const separator = '| ' + headers.map(() => '---').join(' | ') + ' |';
  const dataRows = rows.map(row => '| ' + row.join(' | ') + ' |').join('\n');
  const tableMarkdown = [headerRow, separator, dataRows].join('\n');

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    },
    elements: [
      {
        tag: 'markdown',
        content: tableMarkdown,
      },
    ],
  };
}
