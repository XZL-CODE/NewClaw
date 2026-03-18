/**
 * Message Tool — Let the model proactively send messages to users.
 *
 * This is the core capability of an autonomous AI:
 * the model can initiate communication, not just respond.
 */

import type { ActionResult, ChannelAdapter, ToolDefinition } from '../types/index.js';
import { PermissionLevel } from '../types/index.js';

export const sendMessageDef: ToolDefinition = {
  name: 'send_message',
  description: 'Send a message to the user through a specified channel. This allows proactive communication.',
  parameters: {
    channel: { type: 'string', description: 'Channel name to send through (e.g. "terminal", "telegram")', required: true },
    content: { type: 'string', description: 'Message content to send', required: true },
    to: { type: 'string', description: 'Recipient identifier (channel-specific, e.g. chat ID)' },
  },
  permissionLevel: PermissionLevel.APPROVE,
};

export function createSendMessageExecutor(
  channels: Map<string, ChannelAdapter>,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const channelName = String(args.channel ?? '');
    const content = String(args.content ?? '');
    const to = String(args.to ?? 'user');

    const channel = channels.get(channelName);
    if (!channel) {
      return {
        tool: 'send_message',
        success: false,
        output: '',
        error: `Channel "${channelName}" not found. Available: ${[...channels.keys()].join(', ')}`,
      };
    }

    try {
      await channel.sendMessage(to, content);
      return {
        tool: 'send_message',
        success: true,
        output: `Message sent via ${channelName}`,
      };
    } catch (err) {
      return {
        tool: 'send_message',
        success: false,
        output: '',
        error: String(err),
      };
    }
  };
}
