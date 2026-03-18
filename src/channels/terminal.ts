/**
 * TerminalChannel — Interactive CLI channel.
 *
 * The default channel that works out of the box with no external tokens.
 * Uses readline/promises for interactive input and ANSI codes for color.
 */

import { createInterface, Interface } from 'readline/promises';
import { randomUUID } from 'crypto';
import type { ChannelAdapter, NewClawEvent } from '../types/index.js';

// ANSI color helpers — no external dependency needed
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
} as const;

export class TerminalChannel implements ChannelAdapter {
  readonly name = 'terminal';
  private rl: Interface | null = null;
  private handler: ((event: NewClawEvent) => void) | null = null;
  private running = false;

  async connect(): Promise<void> {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    this.running = true;

    // Print welcome banner
    this.printBanner();

    // Start the input loop
    this.inputLoop();
  }

  async disconnect(): Promise<void> {
    this.running = false;
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    console.log(`\n${ANSI.dim}NewClaw disconnected.${ANSI.reset}`);
  }

  async sendMessage(_to: string, content: string): Promise<void> {
    console.log(`\n${ANSI.cyan}${ANSI.bold}NewClaw >${ANSI.reset} ${content}\n`);
  }

  /** Real-time streaming: write text chunks directly to stdout. */
  streamText(chunk: string): void {
    process.stdout.write(chunk);
  }

  onMessage(handler: (event: NewClawEvent) => void): void {
    this.handler = handler;
  }

  private printBanner(): void {
    console.log(`
${ANSI.cyan}${ANSI.bold}╔══════════════════════════════════════╗
║          NewClaw v0.1.0              ║
║   Autonomous AI Companion            ║
╚══════════════════════════════════════╝${ANSI.reset}
${ANSI.dim}Commands: /quit  /memory  /status${ANSI.reset}
`);
  }

  private async inputLoop(): Promise<void> {
    while (this.running && this.rl) {
      try {
        const input = await this.rl.question(
          `${ANSI.green}${ANSI.bold}You > ${ANSI.reset}`,
        );

        const trimmed = input.trim();
        if (!trimmed) continue;

        // Handle special commands
        if (this.handleSpecialCommand(trimmed)) continue;

        // Emit as NewClawEvent
        if (this.handler) {
          const event: NewClawEvent = {
            id: randomUUID(),
            source: 'user',
            channel: 'terminal',
            timestamp: Date.now(),
            data: { text: trimmed },
            priority: 'normal',
          };
          this.handler(event);
        }
      } catch {
        // readline closed (Ctrl+C / Ctrl+D) — exit gracefully
        this.running = false;
        break;
      }
    }
  }

  private handleSpecialCommand(input: string): boolean {
    switch (input.toLowerCase()) {
      case '/quit':
        console.log(`${ANSI.yellow}Goodbye!${ANSI.reset}`);
        this.running = false;
        this.rl?.close();
        process.emit('SIGINT');
        return true;

      case '/memory':
        if (this.handler) {
          this.handler({
            id: randomUUID(),
            source: 'internal',
            channel: 'terminal',
            timestamp: Date.now(),
            data: { command: 'memory_dump' },
            priority: 'low',
          });
        }
        return true;

      case '/status':
        if (this.handler) {
          this.handler({
            id: randomUUID(),
            source: 'internal',
            channel: 'terminal',
            timestamp: Date.now(),
            data: { command: 'status' },
            priority: 'low',
          });
        }
        return true;

      default:
        return false;
    }
  }
}
