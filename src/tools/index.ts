/**
 * Tool Registry — Register all built-in tools with the ActionExecutor.
 */

import type Database from 'better-sqlite3';
import type { ActionExecutor } from '../core/action-executor.js';
import type { EventCollector } from '../core/event-collector.js';
import type { ChannelAdapter } from '../types/index.js';

import { bashToolDef, executeBash } from './bash.js';
import {
  readFileDef, readFileExecutor,
  writeFileDef, writeFileExecutor,
  searchFilesDef, searchFilesExecutor,
  grepContentDef, grepContentExecutor,
} from './file-ops.js';
import { webSearchDef, webSearchExecutor, webFetchDef, webFetchExecutor } from './web.js';
import { sendMessageDef, createSendMessageExecutor } from './message.js';
import {
  memoryReadDef, memoryWriteDef,
  createMemoryReadExecutor, createMemoryWriteExecutor,
  type MemoryServiceForTools,
} from './memory-tool.js';
import { setTimerDef, createSetTimerExecutor } from './timer.js';
import {
  missionCreateDef, createMissionCreateExecutor,
  missionStatusDef, createMissionStatusExecutor,
  missionPauseDef, createMissionPauseExecutor,
  missionResumeDef, createMissionResumeExecutor,
  missionUpdateStrategyDef, createMissionUpdateStrategyExecutor,
  missionAddLearningDef, createMissionAddLearningExecutor,
  missionReportDef, createMissionReportExecutor,
  missionContinueNowDef, createMissionContinueNowExecutor,
  missionSetIntervalDef, createMissionSetIntervalExecutor,
} from './mission.js';
import type { MissionRunner } from '../mission/runner.js';

/** Shared mutable ref for the most recent event context (channel + replyTo). */
export interface EventContextRef {
  channel: string;
  replyTo: string;
}

interface ToolDeps {
  channels: Map<string, ChannelAdapter>;
  memoryService: MemoryServiceForTools;
  eventCollector: EventCollector;
  db?: Database.Database;
  missionRunner?: MissionRunner;
  eventContextRef?: EventContextRef;
}

export function registerAllTools(executor: ActionExecutor, deps: ToolDeps): void {
  // Bash
  executor.registerTool('bash', bashToolDef, executeBash);

  // File operations
  executor.registerTool('read_file', readFileDef, readFileExecutor);
  executor.registerTool('write_file', writeFileDef, writeFileExecutor);
  executor.registerTool('search_files', searchFilesDef, searchFilesExecutor);
  executor.registerTool('grep_content', grepContentDef, grepContentExecutor);

  // Web
  executor.registerTool('web_search', webSearchDef, webSearchExecutor);
  executor.registerTool('web_fetch', webFetchDef, webFetchExecutor);

  // Message (proactive AI communication)
  executor.registerTool('send_message', sendMessageDef, createSendMessageExecutor(deps.channels));

  // Memory (model-driven memory management)
  executor.registerTool('memory_read', memoryReadDef, createMemoryReadExecutor(deps.memoryService));
  executor.registerTool('memory_write', memoryWriteDef, createMemoryWriteExecutor(deps.memoryService));

  // Timer (model-driven scheduling — replaces cron/heartbeat)
  executor.registerTool('set_timer', setTimerDef, createSetTimerExecutor(deps.eventCollector, deps.db));

  // Mission (autonomous long-running tasks)
  if (deps.missionRunner) {
    const missionStore = deps.missionRunner.getStore();
    const ctxRef = deps.eventContextRef;
    const getEventContext = ctxRef ? () => ({ channel: ctxRef.channel, replyTo: ctxRef.replyTo }) : undefined;
    executor.registerTool('mission_create', missionCreateDef, createMissionCreateExecutor(deps.missionRunner, getEventContext));
    executor.registerTool('mission_status', missionStatusDef, createMissionStatusExecutor(missionStore));
    executor.registerTool('mission_pause', missionPauseDef, createMissionPauseExecutor(deps.missionRunner));
    executor.registerTool('mission_resume', missionResumeDef, createMissionResumeExecutor(deps.missionRunner));
    executor.registerTool('mission_update_strategy', missionUpdateStrategyDef, createMissionUpdateStrategyExecutor(missionStore));
    executor.registerTool('mission_add_learning', missionAddLearningDef, createMissionAddLearningExecutor(missionStore));
    executor.registerTool('mission_report', missionReportDef, createMissionReportExecutor(missionStore));
    executor.registerTool('mission_continue_now', missionContinueNowDef, createMissionContinueNowExecutor(deps.missionRunner));
    executor.registerTool('mission_set_interval', missionSetIntervalDef, createMissionSetIntervalExecutor(deps.missionRunner));
  }
}
