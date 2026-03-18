/**
 * Logger — Unified logging system for NewClaw.
 *
 * Supports info/warn/error/debug levels, outputs to console + local log file.
 * Tracks token usage, tool calls, memory ops, and event timing.
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '\x1b[90m',  // gray
  info: '\x1b[36m',   // cyan
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};

const RESET = '\x1b[0m';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const DEFAULT_LOG_PATH = join(PROJECT_ROOT, 'data', 'newclaw.log');

export class Logger {
  private level: LogLevel;
  private logPath: string;

  constructor(level: LogLevel = 'info', logPath: string = DEFAULT_LOG_PATH) {
    this.level = level;
    this.logPath = logPath;

    // Ensure log directory exists
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  debug(tag: string, message: string, ...args: unknown[]): void {
    this.log('debug', tag, message, ...args);
  }

  info(tag: string, message: string, ...args: unknown[]): void {
    this.log('info', tag, message, ...args);
  }

  warn(tag: string, message: string, ...args: unknown[]): void {
    this.log('warn', tag, message, ...args);
  }

  error(tag: string, message: string, ...args: unknown[]): void {
    this.log('error', tag, message, ...args);
  }

  /** Log token consumption for a model call. */
  logTokens(tag: string, input: number, output: number): void {
    this.info(tag, `Tokens — input: ${input}, output: ${output}, total: ${input + output}`);
  }

  /** Log a tool call with its duration. */
  logToolCall(tool: string, durationMs: number, success: boolean): void {
    const status = success ? 'OK' : 'FAIL';
    this.info('ToolCall', `${tool} → ${status} (${durationMs}ms)`);
  }

  /** Log memory read/write operations. */
  logMemoryOp(op: 'read' | 'write', details: string): void {
    this.debug('Memory', `${op.toUpperCase()}: ${details}`);
  }

  /** Log event processing time. */
  logEventTiming(eventId: string, durationMs: number): void {
    this.info('Event', `${eventId} processed in ${durationMs}ms`);
  }

  private log(level: LogLevel, tag: string, message: string, ...args: unknown[]): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) return;

    const timestamp = new Date().toISOString();
    const extra = args.length > 0
      ? ' ' + args.map(a => (a instanceof Error ? a.message : String(a))).join(' ')
      : '';
    const plain = `[${timestamp}] [${level.toUpperCase()}] [${tag}] ${message}${extra}`;

    // Console output with color
    const color = LEVEL_COLOR[level];
    const levelLabel = level.toUpperCase().padEnd(5);
    console.log(`${color}[${levelLabel}]${RESET} \x1b[2m[${tag}]\x1b[0m ${message}${extra}`);

    // File output (plain text)
    try {
      appendFileSync(this.logPath, plain + '\n');
    } catch {
      // Silently ignore file write errors to avoid infinite loops
    }
  }
}

/** Global singleton logger instance. */
export const logger = new Logger();
