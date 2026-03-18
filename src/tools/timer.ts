/**
 * Timer Tool — Let the model schedule one-shot delayed events.
 *
 * The model decides when to set a timer and what message to deliver.
 * No cron, no heartbeat — just the model saying "remind me at X".
 * This is the core proactive capability that distinguishes NewClaw.
 */

import type Database from 'better-sqlite3';
import type { ActionResult, ToolDefinition } from '../types/index.js';
import type { EventCollector } from '../core/event-collector.js';
import { PermissionLevel } from '../types/index.js';

export const setTimerDef: ToolDefinition = {
  name: 'set_timer',
  description: `Schedule a one-shot timer to trigger a proactive event at a future time.
Use this when the user asks you to remind them, send a message later, or do something at a specific time.
The timer fires once, delivering the message/task back into the event loop so the model can act on it.

Supported time formats:
- Absolute: "13:45", "2026-03-16T14:00:00" (parsed as local time)
- Relative: "5m", "30s", "2h", "1h30m" (from now)`,
  parameters: {
    time: {
      type: 'string',
      description: 'When to fire: absolute ("13:45", "14:00") or relative ("5m", "2h", "30s")',
      required: true,
    },
    message: {
      type: 'string',
      description: 'What to deliver when the timer fires (reminder text, task description, etc.)',
      required: true,
    },
    channel: {
      type: 'string',
      description: 'Which channel to deliver to (e.g. "terminal", "feishu"). Defaults to the channel that set the timer.',
    },
    replyTo: {
      type: 'string',
      description: 'Reply address (chatId for feishu, userId for telegram). Required for non-terminal channels.',
    },
  },
  permissionLevel: PermissionLevel.NOTIFY,
};

/**
 * Parse a time string into milliseconds from now.
 */
function parseDelay(timeStr: string): number | null {
  const trimmed = timeStr.trim();

  // Relative: "30s", "5m", "2h", "1h30m"
  const relMatch = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (relMatch && (relMatch[1] || relMatch[2] || relMatch[3])) {
    const hours = parseInt(relMatch[1] ?? '0', 10);
    const minutes = parseInt(relMatch[2] ?? '0', 10);
    const seconds = parseInt(relMatch[3] ?? '0', 10);
    return (hours * 3600 + minutes * 60 + seconds) * 1000;
  }

  // Absolute time today: "13:45", "14:00"
  const timeMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (timeMatch) {
    const now = new Date();
    const target = new Date();
    target.setHours(parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0, 0);
    // If the time has already passed today, schedule for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime() - now.getTime();
  }

  // ISO datetime: "2026-03-16T14:00:00"
  const isoDate = new Date(trimmed);
  if (!isNaN(isoDate.getTime())) {
    const delay = isoDate.getTime() - Date.now();
    if (delay > 0) return delay;
    return null; // Already passed
  }

  return null;
}

function formatDelay(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}分${seconds}秒` : `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainMins = minutes % 60;
  return remainMins > 0 ? `${hours}小时${remainMins}分钟` : `${hours}小时`;
}

/** Schedule a single timer and register it in memory. */
function scheduleTimer(
  timerId: string,
  delayMs: number,
  channel: string,
  replyTo: string,
  message: string,
  activeTimers: Map<string, NodeJS.Timeout>,
  eventCollector: EventCollector,
  db?: Database.Database,
): void {
  const timeout = setTimeout(() => {
    activeTimers.delete(timerId);
    // Mark as fired in DB
    if (db) {
      db.prepare('UPDATE timers SET fired = 1 WHERE id = ?').run(timerId);
    }
    eventCollector.push('timer', channel, {
      text: `[定时任务触发] 用户之前要求你在此时执行以下任务，请你现在直接完成它，把完整内容发送给用户：\n\n${message}\n\n注意：不要只说"已送达"或"已发送"，你必须现在生成并发送完整的内容。`,
      timerId,
      originalMessage: message,
      scheduledAt: new Date().toISOString(),
      replyTo,
      chatId: replyTo,
    }, 'normal');
  }, delayMs);

  activeTimers.set(timerId, timeout);
}

interface TimerRow {
  id: string;
  channel: string;
  reply_to: string;
  message: string;
  fire_at: number;
  created_at: number;
  fired: number;
}

/** Restore unfired timers from SQLite after restart. */
export function restoreTimers(
  eventCollector: EventCollector,
  db: Database.Database,
  activeTimers: Map<string, NodeJS.Timeout>,
): number {
  const rows = db.prepare(
    'SELECT * FROM timers WHERE fired = 0'
  ).all() as TimerRow[];

  let restored = 0;
  const now = Date.now();

  for (const row of rows) {
    const remaining = row.fire_at - now;
    if (remaining <= 0) {
      // Already past due — fire immediately
      db.prepare('UPDATE timers SET fired = 1 WHERE id = ?').run(row.id);
      eventCollector.push('timer', row.channel, {
        text: `[定时任务触发-延迟恢复] 用户之前要求你在此时执行以下任务，请你现在直接完成它，把完整内容发送给用户：\n\n${row.message}\n\n注意：不要只说"已送达"或"已发送"，你必须现在生成并发送完整的内容。`,
        timerId: row.id,
        originalMessage: row.message,
        scheduledAt: new Date().toISOString(),
        replyTo: row.reply_to,
        chatId: row.reply_to,
      }, 'normal');
    } else {
      scheduleTimer(row.id, remaining, row.channel, row.reply_to, row.message, activeTimers, eventCollector, db);
    }
    restored++;
  }

  if (restored > 0) {
    console.log(`[Timer] Restored ${restored} timer(s) from database`);
  }
  return restored;
}

export function createSetTimerExecutor(
  eventCollector: EventCollector,
  db?: Database.Database,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  // Track active timers for cleanup
  const activeTimers = new Map<string, NodeJS.Timeout>();

  // Restore persisted timers on creation
  if (db) {
    restoreTimers(eventCollector, db, activeTimers);
  }

  // Register cleanup with event collector
  eventCollector.registerSource('timers', () => {
    for (const [, timer] of activeTimers) {
      clearTimeout(timer);
    }
    activeTimers.clear();
  });

  return async (args) => {
    const timeStr = String(args.time ?? '');
    const message = String(args.message ?? '');
    const channel = String(args.channel ?? 'terminal');
    const replyTo = String(args.replyTo ?? 'user');

    if (!timeStr) {
      return { tool: 'set_timer', success: false, output: '', error: '缺少 time 参数' };
    }
    if (!message) {
      return { tool: 'set_timer', success: false, output: '', error: '缺少 message 参数' };
    }

    const delayMs = parseDelay(timeStr);
    if (delayMs === null) {
      return {
        tool: 'set_timer',
        success: false,
        output: '',
        error: `无法解析时间 "${timeStr}"。支持格式：绝对时间 "13:45"、相对时间 "5m"/"2h30m"、ISO "2026-03-16T14:00:00"`,
      };
    }

    // Safety: don't allow timers longer than 24 hours
    if (delayMs > 24 * 60 * 60 * 1000) {
      return {
        tool: 'set_timer',
        success: false,
        output: '',
        error: '定时器最长支持24小时。更长的提醒建议使用日历。',
      };
    }

    const timerId = `timer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const fireAt = new Date(Date.now() + delayMs);

    // Persist to SQLite
    if (db) {
      db.prepare(
        'INSERT INTO timers (id, channel, reply_to, message, fire_at, created_at, fired) VALUES (?, ?, ?, ?, ?, ?, 0)'
      ).run(timerId, channel, replyTo, message, fireAt.getTime(), Date.now());
    }

    scheduleTimer(timerId, delayMs, channel, replyTo, message, activeTimers, eventCollector, db);

    return {
      tool: 'set_timer',
      success: true,
      output: `定时器已设置：将在 ${formatDelay(delayMs)} 后（${fireAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}）触发。\n内容：${message}\n定时器ID：${timerId}`,
    };
  };
}
