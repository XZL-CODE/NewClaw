/**
 * Core module barrel export.
 */

export { EventCollector } from './event-collector.js';
export { ContextAssembler } from './context-assembler.js';
export type { MemoryServiceInterface } from './context-assembler.js';
export { ModelReasoning } from './model-reasoning.js';
export { ActionExecutor } from './action-executor.js';
export type { ApprovalCallback } from './action-executor.js';
export { PermissionBoundary } from './permission.js';
export { MasterLoop } from './master-loop.js';
export type { ResponseCallback, MemoryCallback } from './master-loop.js';
