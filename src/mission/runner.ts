/**
 * MissionRunner — Autonomous execution engine for missions.
 *
 * When a mission's nextRunAt arrives, the runner:
 * 1. Assembles mission-specific context (goal + history + strategy + methodology)
 * 2. Calls the model via ModelReasoning
 * 3. Executes any tool calls the model makes
 * 4. Records results as mission steps
 * 5. Schedules the next run
 *
 * The model runs autonomously — no user interaction during execution.
 */

import type { ActionRequest, ActionResult, ContextWindow, Message, ModelDecision, ToolDefinition } from '../types/index.js';
import type { ModelReasoning } from '../core/model-reasoning.js';
import type { ActionExecutor } from '../core/action-executor.js';
import type { EventCollector } from '../core/event-collector.js';
import type { ResponseCallback } from '../core/master-loop.js';
import { MissionStore, type Mission, type MissionStep } from './store.js';
import { logger } from '../core/logger.js';

const MAX_LOOPS_PER_RUN = 30;
const MAX_RUN_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RETRIES_ON_ERROR = 3;

const MISSION_SYSTEM_PROMPT = `You are executing an autonomous mission. Key rules:

1. You are FORBIDDEN from asking the user any questions. Solve problems yourself.
2. When you encounter errors, analyze the cause and try a different approach. You may retry up to 3 different methods before giving up.
3. After each action, use mission_add_learning to record what you learned.
4. Periodically use mission_update_strategy to refine your approach based on accumulated learnings.
5. ALWAYS use send_message to notify the user when you:
   - Complete a significant step (registration, first trade, etc.)
   - Discover something interesting or unexpected
   - Complete a phase of the mission
   - Encounter an error you resolved (briefly mention what happened)
   Keep notifications concise (1-3 sentences). The channel and to fields are provided in the context below.
6. 如果你有未完成的紧急操作（验证码待提交、交易待确认等），立即调用 mission_continue_now 安排下一轮执行（本轮结束后立即续跑），不要等待定时间隔。每轮最多30次循环或10分钟。
7. 对于需要连续快速操作的阶段（如注册、验证、密集交易），调用 mission_set_interval 切换为 sprint 模式（5分钟间隔）。完成后切回 patrol 模式（30分钟）。
8. Be efficient. Focus on the goal. Don't repeat failed approaches.`;

export class MissionRunner {
  private store: MissionStore;
  private timers = new Map<string, NodeJS.Timeout>();
  private runningMissions = new Set<string>();
  private onResponse: ResponseCallback | null = null;

  constructor(
    private db: import('better-sqlite3').Database,
    private reasoning: ModelReasoning,
    private executor: ActionExecutor,
    private events: EventCollector,
  ) {
    this.store = new MissionStore(db);
  }

  /** Set callback for delivering auto-notifications to the user. */
  setResponseCallback(cb: ResponseCallback): void {
    this.onResponse = cb;
  }

  /** Get the underlying MissionStore for tools to use. */
  getStore(): MissionStore {
    return this.store;
  }

  /** Restore all active missions' timers on startup. */
  restoreActive(): number {
    const active = this.store.listActive();
    const now = Date.now();
    let restored = 0;

    for (const mission of active) {
      const delay = Math.max(0, mission.nextRunAt - now);
      this.scheduleMission(mission.id, delay);
      restored++;
    }

    if (restored > 0) {
      logger.info('MissionRunner', `Restored ${restored} active mission(s)`);
    }
    return restored;
  }

  /** Schedule a mission to run after a delay. */
  scheduleMission(missionId: string, delayMs: number): void {
    // Clear any existing timer
    this.clearTimer(missionId);

    const timeout = setTimeout(() => {
      this.timers.delete(missionId);
      this.executeMission(missionId).catch(err => {
        logger.error('MissionRunner', `Mission ${missionId} execution failed:`, err);
      });
    }, delayMs);

    this.timers.set(missionId, timeout);
  }

  /** Execute a single mission run. */
  async executeMission(missionId: string): Promise<void> {
    // Prevent concurrent runs of the same mission
    if (this.runningMissions.has(missionId)) {
      logger.warn('MissionRunner', `Mission ${missionId} is already running, skipping`);
      return;
    }

    const mission = this.store.get(missionId);
    if (!mission || mission.status !== 'active') return;

    this.runningMissions.add(missionId);
    logger.info('MissionRunner', `Starting mission run: ${mission.goal.slice(0, 60)}...`);

    try {
      await this.runMissionLoop(mission);
    } finally {
      this.runningMissions.delete(missionId);

      // Archive old steps to prevent unbounded growth
      const archived = this.store.archiveOldSteps(missionId);

      // Schedule next run if still active
      const updated = this.store.get(missionId);
      if (updated && updated.status === 'active') {
        if (this.store.hasContinueFlag(missionId)) {
          this.store.clearContinueFlag(missionId);
          // Immediate continuation (1s delay to avoid stack overflow)
          this.scheduleMission(missionId, 1000);
        } else {
          const nextRunAt = Date.now() + updated.runIntervalMs;
          this.store.update(missionId, { nextRunAt });
          this.scheduleMission(missionId, updated.runIntervalMs);
        }
      }
    }
  }

  /** Pause a mission — clear its timer. */
  pauseMission(missionId: string): void {
    this.clearTimer(missionId);
    this.store.update(missionId, { status: 'paused' });
  }

  /** Resume a paused mission — schedule it to run now. */
  resumeMission(missionId: string): void {
    this.store.update(missionId, { status: 'active', nextRunAt: Date.now() });
    this.scheduleMission(missionId, 0);
  }

  /** Immediately schedule the next run of a mission (skip the normal interval). */
  scheduleImmediateRun(missionId: string): void {
    this.clearTimer(missionId);
    this.scheduleMission(missionId, 1000); // 1 second delay
  }

  /** Update a mission's run interval and reschedule. */
  updateInterval(missionId: string, intervalMs: number): void {
    this.store.update(missionId, { runIntervalMs: intervalMs });
    this.clearTimer(missionId);
    this.scheduleMission(missionId, intervalMs);
  }

  /** Stop all mission timers (for shutdown). */
  stopAll(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  // ── Internal ───────────────────────────────────────────────

  private async runMissionLoop(mission: Mission): Promise<void> {
    const history: Message[] = [];
    let loopCount = 0;
    let newStepsWithLearning = 0;
    const runStartTime = Date.now();

    // Self-reflection prompt for long-running missions
    const totalSteps = this.store.getStepCount(mission.id);
    let selfReflectionPrompt = '';
    if (totalSteps > 0 && totalSteps % 50 === 0) {
      selfReflectionPrompt = `\n\n[系统自省提示] 你已连续执行了 ${totalSteps} 步。请评估：\n- 当前目标是否已基本达成？\n- 继续执行的边际收益是否递减？\n- 是否应该暂停并给用户发一份阶段性报告？\n\n你可以：调 mission_pause 暂停 / 调 mission_set_interval 降频 / 用 send_message 询问用户 / 继续执行`;
    }

    // Temporarily enable auto-approve so send_message doesn't deadlock in background
    const savedAutoApprove = this.executor.getPermissions().autoApproveAll;
    this.executor.getPermissions().autoApproveAll = true;

    try {
      while (loopCount < MAX_LOOPS_PER_RUN && (Date.now() - runStartTime) < MAX_RUN_DURATION_MS) {
        loopCount++;

        const context = this.buildContext(mission, history, selfReflectionPrompt);

        let decision;
        try {
          // Use streaming to avoid Anthropic SDK error when maxTokens is large
          decision = await this.collectStreamingDecision(context);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error('MissionRunner', `Model error in mission ${mission.id}:`, err);
          this.store.addStep(mission.id, {
            timestamp: Date.now(),
            action: 'model_call',
            result: `ERROR: ${errMsg}`,
            learning: '',
            success: false,
          });
          break;
        }

        if (decision.type === 'silence' || decision.type === 'respond') {
          // Mission run completed — model has nothing more to do
          if (decision.content) {
            // Record final thoughts
            this.store.addStep(mission.id, {
              timestamp: Date.now(),
              action: 'conclusion',
              result: decision.content.slice(0, 2000),
              learning: '',
              success: true,
            });
            newStepsWithLearning++;
          }
          break;
        }

        if (decision.type === 'act' && decision.actions) {
          // Fix: Force send_message routing to mission's sourceReplyTo
          // The model sometimes ignores the system prompt and sends to user's open_id instead of group chat_id
          for (const action of decision.actions) {
            if (action.tool === 'send_message' && action.args) {
              action.args.channel = mission.sourceChannel;
              action.args.to = mission.sourceReplyTo;
            }
          }

          const results = await this.executor.executeParallel(decision.actions);

          // Feed results back into conversation for next loop
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            const action = decision.actions[i];
            const status = r.success ? 'OK' : 'ERROR';
            const body = r.success ? r.output : r.error;

            history.push({
              role: 'tool',
              content: `[${r.tool}(${JSON.stringify(action?.args ?? {})})] ${status}: ${body}`,
              timestamp: Date.now(),
              toolCallId: action?.toolCallId,
            });

            // Record significant actions as mission steps
            if (!this.isInternalTool(r.tool)) {
              this.store.addStep(mission.id, {
                timestamp: Date.now(),
                action: `${r.tool}(${JSON.stringify(action?.args ?? {}).slice(0, 200)})`,
                result: (r.success ? r.output : r.error ?? 'unknown error').slice(0, 1000),
                learning: '',
                success: r.success,
              });
              newStepsWithLearning++;
            }
          }

          // If the model also produced text, add as assistant message
          if (decision.content) {
            history.push({
              role: 'assistant',
              content: decision.content,
              timestamp: Date.now(),
            });
          }
        }
      }

      // Fix D: When loops/time exhausted, ask model if it needs immediate continuation
      if (loopCount >= MAX_LOOPS_PER_RUN || (Date.now() - runStartTime) >= MAX_RUN_DURATION_MS) {
        const continueCtx = this.buildContext(mission, history);
        continueCtx.recentHistory = [...history, {
          role: 'user' as const,
          content: '[system] 你已用完本轮执行机会。如果你有未完成的紧急操作需要立即继续，请调用 mission_continue_now。否则不需要做任何事。',
          timestamp: Date.now(),
        }];

        try {
          const continueDecision = await this.collectStreamingDecision(continueCtx);
          // If model called mission_continue_now, the flag is set automatically
          // If model called other tools, execute them too
          if (continueDecision.type === 'act' && continueDecision.actions) {
            await this.executor.executeParallel(continueDecision.actions);
          }
        } catch {
          // Ignore errors in continuation query
        }
      }
    } finally {
      // Restore original auto-approve setting
      this.executor.getPermissions().autoApproveAll = savedAutoApprove;
    }

    // System-level auto-notification: if this run produced steps, notify the user
    if (newStepsWithLearning > 0 && this.onResponse) {
      const recentSteps = this.store.getSteps(mission.id, 3);
      const summary = recentSteps
        .map(s => {
          const status = s.success ? '✓' : '✗';
          return `${status} ${s.action.slice(0, 80)}`;
        })
        .join('\n');

      const notification = `🤖 Mission "${mission.goal.slice(0, 50)}" — run completed (${loopCount} loops, ${newStepsWithLearning} actions)\n${summary}`;

      try {
        await this.onResponse(mission.sourceChannel, notification, mission.sourceReplyTo);
      } catch (err) {
        logger.error('MissionRunner', `Failed to send auto-notification for mission ${mission.id}:`, err);
      }
    }

    // Push event to notify system that a mission run completed
    this.events.push('mission', 'mission', {
      text: `[mission_run_completed] Mission "${mission.goal.slice(0, 60)}" completed a run (${loopCount} loops)`,
      missionId: mission.id,
    }, 'low');
  }

  /** Consume the streaming generator and return the final ModelDecision (no real-time output needed for background missions). */
  private async collectStreamingDecision(context: ContextWindow): Promise<ModelDecision> {
    let finalDecision: ModelDecision | null = null;

    for await (const chunk of this.reasoning.reasonStream(context)) {
      if (chunk.type === 'decision') {
        finalDecision = chunk.data as ModelDecision;
      }
      // Text chunks are discarded — background missions don't need real-time streaming
    }

    return finalDecision ?? { type: 'silence' };
  }

  private buildContext(mission: Mission, conversationHistory: Message[], selfReflectionPrompt: string = ''): ContextWindow {
    // Build mission-specific identity/system prompt
    const recentSteps = mission.history.slice(0, 25);
    const historyBlock = recentSteps.length > 0
      ? recentSteps.map(s => {
        const time = new Date(s.timestamp).toISOString();
        const status = s.success ? 'OK' : 'FAIL';
        return `[${time}] ${status}: ${s.action}\n  Result: ${s.result.slice(0, 200)}${s.learning ? `\n  Learning: ${s.learning}` : ''}`;
      }).join('\n')
      : '(no previous steps)';

    const identity = [
      MISSION_SYSTEM_PROMPT,
      `\n## Mission Goal\n${mission.goal}`,
      mission.context ? `\n## Mission Context\n${mission.context}` : '',
      `\n## Current Strategy\n${mission.currentStrategy || '(no strategy set yet — decide one)'}`,
      `\n## Methodology (accumulated learnings)\n${mission.methodology || '(none yet)'}`,
      `\n## Recent Execution History\n${historyBlock}`,
      `\n## Notification Channel\nWhen using send_message, use these values:\n- channel: "${mission.sourceChannel}"\n- to: "${mission.sourceReplyTo}"`,
    ].filter(Boolean).join('\n');

    // Inject a user message to kick off this run
    const kickoffMessage: Message = {
      role: 'user',
      content: `[system] Execute the next step of this autonomous mission. Your goal: ${mission.goal}. ${mission.nextAction ? `Planned next action: ${mission.nextAction}` : 'Decide what to do next based on the history and strategy.'}`,
      timestamp: Date.now(),
    };

    return {
      identity,
      memories: [],
      taskData: `Source: mission\nMission ID: ${mission.id}\n当前时间: ${new Date().toISOString()}\n已执行轮数: ${this.store.getStepCount(mission.id)}轮\n执行间隔: ${mission.runIntervalMs / 60000}分钟${selfReflectionPrompt}`,
      tools: this.executor.getToolDefinitions(),
      recentHistory: [...conversationHistory, kickoffMessage],
    };
  }

  private clearTimer(missionId: string): void {
    const existing = this.timers.get(missionId);
    if (existing) {
      clearTimeout(existing);
      this.timers.delete(missionId);
    }
  }

  /** Check if a tool is "internal" (mission management) — don't record as a step. */
  private isInternalTool(toolName: string): boolean {
    return toolName.startsWith('mission_');
  }
}
