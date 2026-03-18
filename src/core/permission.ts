/**
 * PermissionBoundary — Four-level permission model for tool execution.
 *
 * L0 FREE:      read, search, memory_read → auto-allow
 * L1 NOTIFY:    write, bash(safe) → execute then notify
 * L2 APPROVE:   send_external, deploy → wait for user confirmation
 * L3 FORBIDDEN: delete, expose_creds → hardcoded block
 */

import { PermissionLevel } from '../types/index.js';
import type { ChannelAdapter, NewClawEvent, PermissionConfig } from '../types/index.js';

type PermissionResult = 'allowed' | 'needs_approval' | 'forbidden';

// Default tool → permission level mapping
const DEFAULT_LEVELS: Record<string, PermissionLevel> = {
  // L0 FREE
  read_file: PermissionLevel.FREE,
  search_files: PermissionLevel.FREE,
  grep_content: PermissionLevel.FREE,
  memory_read: PermissionLevel.FREE,
  web_search: PermissionLevel.FREE,
  web_fetch: PermissionLevel.FREE,

  // L1 NOTIFY
  write_file: PermissionLevel.NOTIFY,
  bash: PermissionLevel.NOTIFY,
  memory_write: PermissionLevel.NOTIFY,

  // L2 APPROVE
  send_message: PermissionLevel.APPROVE,

  // L3 FORBIDDEN — configured via PermissionConfig.forbidden
};

export class PermissionBoundary {
  private config: PermissionConfig;
  private levels: Record<string, PermissionLevel>;

  constructor(config: PermissionConfig) {
    this.config = config;
    this.levels = { ...DEFAULT_LEVELS };

    // Override from config
    for (const tool of config.approvalRequired) {
      this.levels[tool] = PermissionLevel.APPROVE;
    }
    for (const tool of config.forbidden) {
      this.levels[tool] = PermissionLevel.FORBIDDEN;
    }
  }

  /** Check permission for a tool at a given level. */
  check(toolName: string, level: PermissionLevel): PermissionResult {
    if (this.config.autoApproveAll) return 'allowed';

    const effectiveLevel = this.levels[toolName] ?? level;

    if (effectiveLevel === PermissionLevel.FORBIDDEN) return 'forbidden';
    if (effectiveLevel === PermissionLevel.APPROVE) return 'needs_approval';
    return 'allowed';
  }

  /** Request user approval through the given channel. Returns true if approved.
   *  Times out after 5 minutes and returns false. */
  async requestApproval(
    toolName: string,
    args: Record<string, unknown>,
    channel: ChannelAdapter,
  ): Promise<boolean> {
    const argsPreview = JSON.stringify(args, null, 2).slice(0, 500);
    const prompt = `⚠️ Permission required: \`${toolName}\`\nArgs: ${argsPreview}\n\nApprove? (y/n)`;

    await channel.sendMessage('user', prompt);

    // Wait for user response with a timeout to prevent indefinite blocking
    const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

    return new Promise<boolean>((resolve) => {
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(false); // Deny on timeout
        }
      }, APPROVAL_TIMEOUT_MS);

      // Register a one-time handler for the approval response
      channel.onMessage((event: NewClawEvent) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        const text = String(event.data.text ?? '').trim().toLowerCase();
        resolve(text === 'y' || text === 'yes');
      });
    });
  }
}
