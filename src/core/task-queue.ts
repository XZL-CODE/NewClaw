/**
 * TaskQueue — Lightweight async task queue for NewClaw.
 *
 * Allows MasterLoop to push long-running processEvent calls into
 * background execution while continuing to handle new events.
 * Uses Promise concurrency (no Worker Threads needed).
 */

import { randomUUID } from 'crypto';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TaskHandle {
  id: string;
  status: TaskStatus;
  result?: unknown;
  error?: string;
}

/** Callback invoked when a background task finishes. */
export type TaskDoneCallback = (handle: TaskHandle) => void;

export class TaskQueue {
  private tasks = new Map<string, TaskHandle>();
  private running = 0;
  private waiting: Array<{ fn: () => Promise<unknown>; handle: TaskHandle }> = [];
  private onDone: TaskDoneCallback | null = null;

  constructor(private maxConcurrency: number = 5) {}

  /** Register a callback for when tasks complete. */
  setDoneCallback(cb: TaskDoneCallback): void {
    this.onDone = cb;
  }

  /** Push a task into the queue. Returns a handle for tracking. */
  push(fn: () => Promise<unknown>): TaskHandle {
    const handle: TaskHandle = { id: randomUUID(), status: 'pending' };
    this.tasks.set(handle.id, handle);

    if (this.running < this.maxConcurrency) {
      this.runTask(fn, handle);
    } else {
      this.waiting.push({ fn, handle });
    }

    return handle;
  }

  /** Get a task handle by ID. */
  get(id: string): TaskHandle | undefined {
    return this.tasks.get(id);
  }

  /** Number of currently running tasks. */
  get activeCount(): number {
    return this.running;
  }

  /** Number of tasks waiting to run. */
  get pendingCount(): number {
    return this.waiting.length;
  }

  private runTask(fn: () => Promise<unknown>, handle: TaskHandle): void {
    this.running++;
    handle.status = 'running';

    fn()
      .then((result) => {
        handle.status = 'completed';
        handle.result = result;
      })
      .catch((err) => {
        handle.status = 'failed';
        handle.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        this.running--;
        if (this.onDone) this.onDone(handle);
        this.drainWaiting();
      });
  }

  private drainWaiting(): void {
    while (this.running < this.maxConcurrency && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.runTask(next.fn, next.handle);
    }
  }
}
