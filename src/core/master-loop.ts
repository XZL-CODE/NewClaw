/**
 * MasterLoop — The single-threaded main loop of NewClaw.
 *
 * CC's core insight: while (model produces tool_call) { execute; feed back }
 *
 * The loop awaits events (no polling), assembles context, lets the model
 * decide, executes actions, and feeds results back until the model responds
 * with text or stays silent.
 *
 * Enhancements over v1:
 * - Error feedback to user (no more silent failures)
 * - Background task queue for concurrent event processing
 * - Streaming mode for real-time text output
 */

import type {
  ActionRequest,
  ActionResult,
  ChannelAdapter,
  Message,
  ModelDecision,
  NewClawConfig,
  NewClawEvent,
} from '../types/index.js';
import { EventCollector } from './event-collector.js';
import { ContextAssembler } from './context-assembler.js';
import { ModelReasoning } from './model-reasoning.js';
import { ActionExecutor } from './action-executor.js';
import { TaskQueue } from './task-queue.js';
import { logger } from './logger.js';
import { metrics } from './metrics.js';

/** Callback for delivering the model's final text response. replyTo is the target address (e.g. chatId for feishu). */
export type ResponseCallback = (channel: string, content: string, replyTo: string) => Promise<void>;

/** Callback for persisting a memory note when the model requests it. */
export type MemoryCallback = (note: string) => Promise<void>;

/** Callback for streaming text chunks to a channel. */
export type StreamCallback = (channel: string, chunk: string) => void;

/** Callback fired when an event starts processing, before any reasoning. */
export type EventStartCallback = (channel: string, replyTo: string) => void;

export class MasterLoop {
  private running = false;
  private onResponse: ResponseCallback | null = null;
  private onMemory: MemoryCallback | null = null;
  private onStream: StreamCallback | null = null;
  private onEventStart: EventStartCallback | null = null;
  private taskQueue: TaskQueue;

  constructor(
    private config: NewClawConfig,
    private events: EventCollector,
    private context: ContextAssembler,
    private reasoning: ModelReasoning,
    private executor: ActionExecutor,
  ) {
    this.taskQueue = new TaskQueue(config.maxConcurrentTasks ?? 5);

    // When a background task fails, log it
    this.taskQueue.setDoneCallback((handle) => {
      if (handle.status === 'failed') {
        logger.error('MasterLoop', `Background task ${handle.id} failed:`, handle.error);
      }
    });
  }

  /** Set callback for delivering responses to the user. */
  setResponseCallback(cb: ResponseCallback): void {
    this.onResponse = cb;
  }

  /** Set callback for persisting memories. */
  setMemoryCallback(cb: MemoryCallback): void {
    this.onMemory = cb;
  }

  /** Set callback for streaming text chunks. */
  setStreamCallback(cb: StreamCallback): void {
    this.onStream = cb;
  }

  /** Set callback fired when an event starts processing (before reasoning). */
  setEventStartCallback(cb: EventStartCallback): void {
    this.onEventStart = cb;
  }

  /** Start the main loop. Runs until stop() is called. */
  async start(): Promise<void> {
    this.running = true;
    await this.events.start();

    while (this.running) {
      // Event-driven wait: block until an event arrives (no polling)
      if (!this.events.hasPending) {
        await this.events.waitForEvent();
      }
      if (!this.running) break;

      const batch = this.events.drain();
      for (const event of batch) {
        if (!this.running) break;

        // Log incoming message so the operator can see it in console
        const text = typeof event.data.text === 'string' ? event.data.text : JSON.stringify(event.data);
        const user = String(event.data.username || event.data.userId || '');
        logger.info('MasterLoop', `[${event.channel}] ${user ? user + ': ' : ''}${text}`);

        // Push event processing to background queue so we don't block on long-running events
        this.taskQueue.push(() => this.processEventSafe(event));
      }
    }
  }

  /** Gracefully stop the loop. */
  async stop(): Promise<void> {
    this.running = false;
    this.events.wakeUp(); // Unblock waitForEvent if sleeping
    await this.events.stop();
  }

  /** Wrapper that catches errors and sends fallback error messages to the user. */
  private async processEventSafe(event: NewClawEvent): Promise<void> {
    const replyTo = String(event.data.chatId ?? event.data.userId ?? 'user');
    const startTime = Date.now();
    metrics.recordEvent();
    try {
      await this.processEvent(event);
      logger.logEventTiming(event.id, Date.now() - startTime);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('MasterLoop', `Error processing event ${event.id}:`, err);

      // Deliver error to user so they don't just see silence
      if (this.onResponse) {
        await this.onResponse(event.channel, `⚠️ 处理出错：${errMsg}`, replyTo).catch(() => {
          // If even the error delivery fails, just log it
          logger.error('MasterLoop', 'Failed to deliver error message to user');
        });
      }
    }
  }

  /** Process a single event through the full reasoning cycle. */
  private async processEvent(event: NewClawEvent): Promise<void> {
    // Extract userId for per-user history isolation
    const userId = typeof event.data.userId === 'string' ? event.data.userId : undefined;

    // Record the incoming event as a user message in history
    const userMessage: Message = {
      role: 'user',
      content: typeof event.data.text === 'string'
        ? event.data.text
        : JSON.stringify(event.data),
      timestamp: event.timestamp,
      channel: event.channel,
    };
    this.context.addToHistory(userMessage, userId);

    // Extract reply address from event (chatId for feishu, userId for telegram, etc.)
    const replyTo = String(event.data.chatId ?? event.data.userId ?? 'user');

    // Notify listeners of the current event context (so tools like mission_create capture the source channel)
    if (this.onEventStart) {
      this.onEventStart(event.channel, replyTo);
    }

    // The core CC loop: reason → act → feed back → repeat
    let loopCount = 0;
    const maxLoops = 25; // Safety limit
    let deliveredResponse = false;

    while (loopCount < maxLoops) {
      loopCount++;

      const contextWindow = await this.context.assemble(
        event,
        this.executor.getToolDefinitions(),
      );

      let decision: ModelDecision;
      try {
        // Always use streaming — required for large maxTokens (Anthropic SDK enforces this)
        if (this.config.useStreaming === false) {
          decision = await this.reasoning.reason(contextWindow);
        } else {
          decision = await this.processStreaming(contextWindow, event.channel);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error('MasterLoop', `Model API error on loop ${loopCount}:`, err);
        // Feed the error back so the model can see it on retry
        this.context.addToHistory({
          role: 'user',
          content: `[system] Model API call failed: ${errMsg}`,
          timestamp: Date.now(),
        }, userId);

        // If this is the first loop, send the error to the user immediately
        if (loopCount === 1 && this.onResponse) {
          await this.onResponse(event.channel, `⚠️ 处理出错：${errMsg}`, replyTo);
          deliveredResponse = true;
        }
        break; // Don't retry blindly — let the next event trigger recovery
      }

      // Handle the model's decision
      if (decision.type === 'silence') {
        break;
      }

      if (decision.type === 'respond') {
        await this.deliverResponse(event.channel, decision.content!, replyTo, userId);
        await this.handleMemory(decision);
        deliveredResponse = true;
        break;
      }

      if (decision.type === 'act') {
        // Execute all requested actions (parallel for independent calls)
        const results = await this.executor.executeParallel(decision.actions!);

        // Feed results back into history so the model sees them
        this.feedbackResults(decision.actions!, results, userId);

        // If the model also produced text alongside tool calls, deliver it
        if (decision.content) {
          await this.deliverResponse(event.channel, decision.content, replyTo, userId);
          deliveredResponse = true;
        }

        await this.handleMemory(decision);

        // Loop continues — model may want to act again based on results
      }
    }

    // Fallback: if loop exhausted without delivering a response, notify user
    if (loopCount >= maxLoops && !deliveredResponse && this.onResponse) {
      await this.onResponse(
        event.channel,
        '⚠️ 处理出错：处理轮次超过上限，请稍后重试',
        replyTo,
      );
      logger.warn('MasterLoop', `Safety limit reached (${maxLoops} loops) for event ${event.id}`);
    }
  }

  /** Stream a reasoning response, sending text chunks in real-time. Returns the final decision. */
  private async processStreaming(
    contextWindow: Parameters<ModelReasoning['reason']>[0],
    channel: string,
  ): Promise<ModelDecision> {
    let finalDecision: ModelDecision | null = null;

    for await (const chunk of this.reasoning.reasonStream(contextWindow)) {
      if (chunk.type === 'text' && typeof chunk.data === 'string') {
        // Stream text chunk to channel
        if (this.onStream) {
          this.onStream(channel, chunk.data);
        }
      } else if (chunk.type === 'decision') {
        finalDecision = chunk.data as ModelDecision;
      }
    }

    if (!finalDecision) {
      return { type: 'silence' };
    }
    return finalDecision;
  }

  /** Deliver a text response via the registered callback. */
  private async deliverResponse(channel: string, content: string, replyTo: string, userId?: string): Promise<void> {
    const assistantMsg: Message = {
      role: 'assistant',
      content,
      timestamp: Date.now(),
      channel,
    };
    this.context.addToHistory(assistantMsg, userId);

    if (this.onResponse) {
      await this.onResponse(channel, content, replyTo);
    }
  }

  /** Feed tool execution results back into the conversation history with tool call context. */
  private feedbackResults(actions: ActionRequest[], results: ActionResult[], userId?: string): void {
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const action = actions[i];
      const status = r.success ? 'OK' : 'ERROR';
      const body = r.success ? r.output : r.error;

      this.context.addToHistory({
        role: 'tool' as Message['role'],
        content: `[${r.tool}(${JSON.stringify(action?.args ?? {})})] ${status}: ${body}`,
        timestamp: Date.now(),
        toolCallId: action?.toolCallId,
      }, userId);
    }
  }

  /** Persist a memory note if the model requested it. */
  private async handleMemory(decision: ModelDecision): Promise<void> {
    if (decision.shouldRemember && decision.memoryNote && this.onMemory) {
      await this.onMemory(decision.memoryNote);
    }
  }
}
