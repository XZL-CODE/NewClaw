/**
 * EventCollector — Unified event ingestion for NewClaw.
 *
 * Replaces OpenClaw's Heartbeat+Cron dual system with a single
 * priority-sorted event queue. Receives events from webhooks,
 * file watchers, channels, and internal timers.
 */

import { EventEmitter } from 'events';
import express, { Express } from 'express';
import { watch, FSWatcher } from 'fs';
import { randomUUID } from 'crypto';
import type { NewClawEvent, EventSource } from '../types/index.js';

const PRIORITY_ORDER = { critical: 0, normal: 1, low: 2 } as const;

/** An event filter function. Returns true to keep, false to discard. */
export type EventFilter = (event: NewClawEvent) => boolean;

export class EventCollector extends EventEmitter {
  private queue: NewClawEvent[] = [];
  private app: Express | null = null;
  private server: ReturnType<Express['listen']> | null = null;
  private watchers: FSWatcher[] = [];
  private sources = new Map<string, () => void>(); // name → cleanup fn
  private wakeResolver: (() => void) | null = null; // For event-driven wait
  private filters = new Map<string, EventFilter>();

  constructor(private webhookPort?: number) {
    super();
    // Built-in default filters
    this.addFilter('empty_message', (event) => {
      const text = event.data.text;
      if (typeof text === 'string' && text.trim() === '') return false;
      return true;
    });
  }

  /** Add a named filter. All filters must pass for an event to be enqueued. */
  addFilter(name: string, fn: EventFilter): void {
    this.filters.set(name, fn);
  }

  /** Remove a named filter. */
  removeFilter(name: string): void {
    this.filters.delete(name);
  }

  /** Add a filter that discards events from a specific bot (by appId or userId). */
  addBotFilter(botId: string): void {
    this.addFilter(`bot_${botId}`, (event) => {
      return event.data.userId !== botId && event.data.appId !== botId;
    });
  }

  /** Start the webhook HTTP server and begin accepting events. */
  async start(): Promise<void> {
    if (this.webhookPort) {
      this.app = express();
      this.app.use(express.json());

      this.app.post('/webhook/:channel', (req, res) => {
        const event = this.createEvent('webhook', req.params.channel, req.body);
        this.enqueue(event);
        res.status(200).json({ ok: true, eventId: event.id });
      });

      await new Promise<void>((resolve) => {
        this.server = this.app!.listen(this.webhookPort, () => resolve());
      });
    }
  }

  /** Push an event from any source. */
  push(source: EventSource, channel: string, data: Record<string, unknown>, priority: NewClawEvent['priority'] = 'normal'): void {
    this.enqueue(this.createEvent(source, channel, data, priority));
  }

  /** Watch a file or directory for changes. */
  watchPath(path: string, channel: string = 'file_watch'): void {
    const watcher = watch(path, { recursive: true }, (_eventType, filename) => {
      this.push('file_watch', channel, { path, filename: filename ?? path }, 'low');
    });
    this.watchers.push(watcher);
  }

  /** Register a named event source with a cleanup function. */
  registerSource(name: string, cleanup: () => void): void {
    this.sources.set(name, cleanup);
  }

  /** Unregister a named event source and call its cleanup. */
  unregisterSource(name: string): void {
    const cleanup = this.sources.get(name);
    if (cleanup) {
      cleanup();
      this.sources.delete(name);
    }
  }

  /** Drain all queued events, sorted by priority. Atomic swap prevents race conditions. */
  drain(): NewClawEvent[] {
    // Atomic swap: grab the queue and replace with empty array in one step
    const events = this.queue;
    this.queue = [];
    return events.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
  }

  /** Check if there are pending events. */
  get hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** Block until at least one event arrives. Event-driven, no polling. */
  waitForEvent(): Promise<void> {
    if (this.queue.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.wakeResolver = resolve;
    });
  }

  /** Unblock waitForEvent (called on stop or when an event arrives). */
  wakeUp(): void {
    if (this.wakeResolver) {
      this.wakeResolver();
      this.wakeResolver = null;
    }
  }

  /** Gracefully shut down all sources. */
  async stop(): Promise<void> {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];

    // Copy keys to avoid deleting from Map during iteration
    const sourceNames = [...this.sources.keys()];
    for (const name of sourceNames) {
      const cleanup = this.sources.get(name);
      if (cleanup) cleanup();
    }
    this.sources.clear();

    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
      this.app = null;
    }
  }

  private enqueue(event: NewClawEvent): void {
    // Run all filters — event must pass every one
    for (const [name, filter] of this.filters) {
      if (!filter(event)) {
        this.emit('filtered', event, name);
        return;
      }
    }

    this.queue.push(event);
    this.wakeUp(); // Unblock the master loop if it's waiting
    this.emit('event', event);
  }

  private createEvent(
    source: EventSource,
    channel: string,
    data: Record<string, unknown>,
    priority: NewClawEvent['priority'] = 'normal',
  ): NewClawEvent {
    return {
      id: randomUUID(),
      source,
      channel,
      timestamp: Date.now(),
      data,
      priority,
    };
  }
}
