/**
 * Mission Tools — Let the model create and manage autonomous missions.
 *
 * All tools are NOTIFY level — they execute and notify the user afterward.
 */

import type { ActionResult, ToolDefinition } from '../types/index.js';
import type { MissionRunner } from '../mission/runner.js';
import type { MissionStore } from '../mission/store.js';
import { PermissionLevel } from '../types/index.js';

// ── Tool Definitions ──────────────────────────────────────────

export const missionCreateDef: ToolDefinition = {
  name: 'mission_create',
  description: `Create a new autonomous mission. The mission will execute on a recurring schedule without user intervention.
Use this when the user gives you a long-running goal that requires iterative work (e.g., "research X topic", "monitor Y system", "optimize Z metric").
The mission will run every runIntervalMinutes (default 30) and you'll autonomously execute, learn, and iterate.`,
  parameters: {
    goal: {
      type: 'string',
      description: 'The high-level goal for this mission',
      required: true,
    },
    context: {
      type: 'string',
      description: 'Background information (API docs, account info, constraints, etc.)',
    },
    runIntervalMinutes: {
      type: 'number',
      description: 'How often to run this mission in minutes (default: 30)',
    },
    channel: {
      type: 'string',
      description: 'Source channel for notifications (auto-filled from current event)',
    },
    replyTo: {
      type: 'string',
      description: 'Reply-to address for notifications (auto-filled from current event)',
    },
  },
  permissionLevel: PermissionLevel.NOTIFY,
};

export const missionStatusDef: ToolDefinition = {
  name: 'mission_status',
  description: 'View the status, history, strategy, and methodology of a mission. Use mission_id="all" to list all missions.',
  parameters: {
    mission_id: {
      type: 'string',
      description: 'The mission ID to inspect, or "all" to list all missions',
      required: true,
    },
  },
  permissionLevel: PermissionLevel.FREE,
};

export const missionPauseDef: ToolDefinition = {
  name: 'mission_pause',
  description: 'Pause an active mission. It will stop executing until resumed.',
  parameters: {
    mission_id: {
      type: 'string',
      description: 'The mission ID to pause',
      required: true,
    },
  },
  permissionLevel: PermissionLevel.NOTIFY,
};

export const missionResumeDef: ToolDefinition = {
  name: 'mission_resume',
  description: 'Resume a paused mission. It will start executing again immediately.',
  parameters: {
    mission_id: {
      type: 'string',
      description: 'The mission ID to resume',
      required: true,
    },
  },
  permissionLevel: PermissionLevel.NOTIFY,
};

export const missionUpdateStrategyDef: ToolDefinition = {
  name: 'mission_update_strategy',
  description: 'Update the current strategy for a mission. Call this when you want to change your approach based on learnings.',
  parameters: {
    mission_id: {
      type: 'string',
      description: 'The mission ID',
      required: true,
    },
    strategy: {
      type: 'string',
      description: 'The new strategy description',
      required: true,
    },
  },
  permissionLevel: PermissionLevel.NOTIFY,
};

export const missionAddLearningDef: ToolDefinition = {
  name: 'mission_add_learning',
  description: 'Record what you learned from this execution step. This builds up the mission methodology over time.',
  parameters: {
    mission_id: {
      type: 'string',
      description: 'The mission ID',
      required: true,
    },
    learning: {
      type: 'string',
      description: 'What you learned (will be appended to methodology)',
      required: true,
    },
  },
  permissionLevel: PermissionLevel.NOTIFY,
};

export const missionReportDef: ToolDefinition = {
  name: 'mission_report',
  description: 'Generate a full methodology report for a mission. Returns the accumulated strategy, learnings, and execution history. You decide whether to send this to the user via send_message.',
  parameters: {
    mission_id: {
      type: 'string',
      description: 'The mission ID',
      required: true,
    },
  },
  permissionLevel: PermissionLevel.FREE,
};

export const missionContinueNowDef: ToolDefinition = {
  name: 'mission_continue_now',
  description: '立即安排下一轮 Mission 执行，不等待定时间隔。用于紧急操作（验证码提交、交易确认等）。',
  parameters: {
    mission_id: { type: 'string', description: 'Mission ID', required: true },
  },
  permissionLevel: PermissionLevel.FREE,
};

export const missionSetIntervalDef: ToolDefinition = {
  name: 'mission_set_interval',
  description: '调整 Mission 的执行间隔。sprint模式（5分钟）用于密集操作，patrol模式（30分钟）用于日常巡逻。',
  parameters: {
    mission_id: { type: 'string', description: 'Mission ID', required: true },
    mode: { type: 'string', description: '"sprint"（5分钟）或 "patrol"（30分钟）或自定义分钟数', required: true },
  },
  permissionLevel: PermissionLevel.FREE,
};

// ── Executor Factories ────────────────────────────────────────

export function createMissionCreateExecutor(
  runner: MissionRunner,
  getEventContext?: () => { channel: string; replyTo: string },
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const goal = String(args.goal ?? '');
    if (!goal) {
      return { tool: 'mission_create', success: false, output: '', error: 'goal is required' };
    }

    const context = String(args.context ?? '');
    const intervalMin = Number(args.runIntervalMinutes ?? 30);
    const intervalMs = intervalMin * 60 * 1000;

    // Determine source channel: explicit args > current event context > defaults
    const eventCtx = getEventContext?.();
    const sourceChannel = String(args.channel ?? eventCtx?.channel ?? 'terminal');
    const sourceReplyTo = String(args.replyTo ?? eventCtx?.replyTo ?? 'user');

    const store = runner.getStore();
    const mission = store.create({
      goal,
      context,
      runIntervalMs: intervalMs,
      sourceChannel,
      sourceReplyTo,
    });

    // Schedule it to run immediately
    runner.scheduleMission(mission.id, 0);

    return {
      tool: 'mission_create',
      success: true,
      output: `Mission created: ${mission.id}\nGoal: ${goal}\nInterval: ${intervalMin} minutes\nNotify via: ${sourceChannel} → ${sourceReplyTo}\nStatus: active (first run starting now)`,
    };
  };
}

export function createMissionStatusExecutor(
  store: MissionStore,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const id = String(args.mission_id ?? '');

    if (id === 'all') {
      const missions = store.listAll();
      if (missions.length === 0) {
        return { tool: 'mission_status', success: true, output: 'No missions found.' };
      }
      const summary = missions.map(m =>
        `[${m.status}] ${m.id.slice(0, 8)}... — ${m.goal.slice(0, 80)} (${m.history.length} steps, interval: ${Math.round(m.runIntervalMs / 60000)}min)`
      ).join('\n');
      return { tool: 'mission_status', success: true, output: summary };
    }

    const mission = store.get(id);
    if (!mission) {
      return { tool: 'mission_status', success: false, output: '', error: `Mission ${id} not found` };
    }

    const recentSteps = mission.history.slice(0, 5).map(s => {
      const time = new Date(s.timestamp).toLocaleString('zh-CN');
      const status = s.success ? 'OK' : 'FAIL';
      return `  [${time}] ${status}: ${s.action.slice(0, 100)}`;
    }).join('\n');

    const output = [
      `Mission: ${mission.id}`,
      `Goal: ${mission.goal}`,
      `Status: ${mission.status}`,
      `Strategy: ${mission.currentStrategy || '(none)'}`,
      `Methodology: ${mission.methodology || '(none)'}`,
      `Steps: ${mission.history.length}`,
      `Interval: ${Math.round(mission.runIntervalMs / 60000)} minutes`,
      `Next run: ${new Date(mission.nextRunAt).toLocaleString('zh-CN')}`,
      `\nRecent steps:\n${recentSteps || '  (none)'}`,
    ].join('\n');

    return { tool: 'mission_status', success: true, output };
  };
}

export function createMissionPauseExecutor(
  runner: MissionRunner,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const id = String(args.mission_id ?? '');
    if (!id) return { tool: 'mission_pause', success: false, output: '', error: 'mission_id is required' };

    runner.pauseMission(id);
    return { tool: 'mission_pause', success: true, output: `Mission ${id} paused.` };
  };
}

export function createMissionResumeExecutor(
  runner: MissionRunner,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const id = String(args.mission_id ?? '');
    if (!id) return { tool: 'mission_resume', success: false, output: '', error: 'mission_id is required' };

    runner.resumeMission(id);
    return { tool: 'mission_resume', success: true, output: `Mission ${id} resumed. Next run: now.` };
  };
}

export function createMissionUpdateStrategyExecutor(
  store: MissionStore,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const id = String(args.mission_id ?? '');
    const strategy = String(args.strategy ?? '');
    if (!id || !strategy) {
      return { tool: 'mission_update_strategy', success: false, output: '', error: 'mission_id and strategy are required' };
    }

    const updated = store.update(id, { currentStrategy: strategy });
    if (!updated) {
      return { tool: 'mission_update_strategy', success: false, output: '', error: `Mission ${id} not found` };
    }

    return { tool: 'mission_update_strategy', success: true, output: `Strategy updated for mission ${id}.` };
  };
}

export function createMissionAddLearningExecutor(
  store: MissionStore,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const id = String(args.mission_id ?? '');
    const learning = String(args.learning ?? '');
    if (!id || !learning) {
      return { tool: 'mission_add_learning', success: false, output: '', error: 'mission_id and learning are required' };
    }

    const mission = store.get(id);
    if (!mission) {
      return { tool: 'mission_add_learning', success: false, output: '', error: `Mission ${id} not found` };
    }

    // Append learning to methodology with timestamp
    const timestamp = new Date().toISOString().slice(0, 16);
    const newMethodology = mission.methodology
      ? `${mission.methodology}\n[${timestamp}] ${learning}`
      : `[${timestamp}] ${learning}`;

    store.updateMethodology(id, newMethodology);

    return { tool: 'mission_add_learning', success: true, output: `Learning recorded for mission ${id}.` };
  };
}

export function createMissionReportExecutor(
  store: MissionStore,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const id = String(args.mission_id ?? '');
    if (!id) return { tool: 'mission_report', success: false, output: '', error: 'mission_id is required' };

    const mission = store.get(id);
    if (!mission) {
      return { tool: 'mission_report', success: false, output: '', error: `Mission ${id} not found` };
    }

    const successCount = mission.history.filter(s => s.success).length;
    const failCount = mission.history.filter(s => !s.success).length;

    const report = [
      `# Mission Report`,
      `## Goal\n${mission.goal}`,
      `## Status\n${mission.status}`,
      `## Current Strategy\n${mission.currentStrategy || '(none set)'}`,
      `## Methodology\n${mission.methodology || '(none accumulated)'}`,
      `## Statistics\n- Total steps: ${mission.history.length}\n- Success: ${successCount}\n- Failures: ${failCount}\n- Run interval: ${Math.round(mission.runIntervalMs / 60000)} minutes`,
      `## Context\n${mission.context || '(none)'}`,
    ].join('\n\n');

    return { tool: 'mission_report', success: true, output: report };
  };
}

export function createMissionContinueNowExecutor(
  runner: MissionRunner,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const id = String(args.mission_id ?? '');
    if (!id) return { tool: 'mission_continue_now', success: false, output: '', error: 'mission_id is required' };

    const store = runner.getStore();
    const mission = store.get(id);
    if (!mission) {
      return { tool: 'mission_continue_now', success: false, output: '', error: `Mission ${id} not found` };
    }
    if (mission.status !== 'active') {
      return { tool: 'mission_continue_now', success: false, output: '', error: `Mission ${id} is not active (status: ${mission.status})` };
    }

    runner.getStore().setContinueFlag(id);
    return { tool: 'mission_continue_now', success: true, output: '已标记：本轮结束后立即续跑下一轮。' };
  };
}

export function createMissionSetIntervalExecutor(
  runner: MissionRunner,
): (args: Record<string, unknown>) => Promise<ActionResult> {
  return async (args) => {
    const id = String(args.mission_id ?? '');
    const mode = String(args.mode ?? '');
    if (!id || !mode) {
      return { tool: 'mission_set_interval', success: false, output: '', error: 'mission_id and mode are required' };
    }

    const store = runner.getStore();
    const mission = store.get(id);
    if (!mission) {
      return { tool: 'mission_set_interval', success: false, output: '', error: `Mission ${id} not found` };
    }

    let intervalMs: number;
    if (mode === 'sprint') {
      intervalMs = 5 * 60 * 1000;
    } else if (mode === 'patrol') {
      intervalMs = 30 * 60 * 1000;
    } else {
      const minutes = Number(mode);
      if (isNaN(minutes) || minutes <= 0) {
        return { tool: 'mission_set_interval', success: false, output: '', error: `Invalid mode: "${mode}". Use "sprint", "patrol", or a number of minutes.` };
      }
      intervalMs = minutes * 60 * 1000;
    }

    runner.updateInterval(id, intervalMs);
    return { tool: 'mission_set_interval', success: true, output: `Mission ${id} interval updated to ${intervalMs / 60000} minutes (${mode}).` };
  };
}
