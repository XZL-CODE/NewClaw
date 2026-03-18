/**
 * ActionExecutor — Tool registration, permission checking, and execution.
 *
 * Tools are registered with a definition and an executor function.
 * Before execution, the permission level is checked against the
 * configured policy. Independent tool calls can run in parallel.
 */

import type {
  ActionRequest,
  ActionResult,
  PermissionConfig,
  PermissionLevel,
  ToolDefinition,
  ToolExecutor,
} from '../types/index.js';
import { PermissionLevel as PL } from '../types/index.js';

interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

/** Callback to request user approval for a tool invocation. */
export type ApprovalCallback = (tool: string, args: Record<string, unknown>) => Promise<boolean>;

export class ActionExecutor {
  private tools = new Map<string, RegisteredTool>();
  private approvalCallback: ApprovalCallback | null = null;

  constructor(private permissions: PermissionConfig) {}

  /** Register a tool with its definition and executor. */
  registerTool(name: string, definition: ToolDefinition, executor: ToolExecutor): void {
    this.tools.set(name, { definition, executor });
  }

  /** Get the mutable permissions config (for temporary overrides like mission auto-approve). */
  getPermissions(): PermissionConfig {
    return this.permissions;
  }

  /** Set the callback used to request user approval for APPROVE-level tools. */
  setApprovalCallback(cb: ApprovalCallback): void {
    this.approvalCallback = cb;
  }

  /** Get all registered tool definitions (for context assembly). */
  getToolDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /** Execute a single action request after permission checks. */
  async execute(request: ActionRequest): Promise<ActionResult> {
    const registered = this.tools.get(request.tool);
    if (!registered) {
      return { tool: request.tool, success: false, output: '', error: `Unknown tool: ${request.tool}` };
    }

    // Permission check
    const denied = await this.checkPermission(request);
    if (denied) return denied;

    try {
      const result = await registered.executor(request.args);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { tool: request.tool, success: false, output: '', error: message };
    }
  }

  /** Execute multiple independent actions in parallel. */
  async executeParallel(requests: ActionRequest[]): Promise<ActionResult[]> {
    return Promise.all(requests.map((r) => this.execute(r)));
  }

  private async checkPermission(request: ActionRequest): Promise<ActionResult | null> {
    // Hard block on forbidden tools
    if (this.permissions.forbidden.includes(request.tool)) {
      return {
        tool: request.tool,
        success: false,
        output: '',
        error: `Tool "${request.tool}" is forbidden by policy`,
      };
    }

    // FORBIDDEN permission level is always blocked
    if (request.permissionLevel === PL.FORBIDDEN) {
      return {
        tool: request.tool,
        success: false,
        output: '',
        error: `Tool "${request.tool}" has FORBIDDEN permission level`,
      };
    }

    // Auto-approve all (dev mode)
    if (this.permissions.autoApproveAll) return null;

    // Check if approval is needed
    const needsApproval =
      request.permissionLevel >= PL.APPROVE ||
      this.permissions.approvalRequired.includes(request.tool);

    if (needsApproval) {
      if (!this.approvalCallback) {
        return {
          tool: request.tool,
          success: false,
          output: '',
          error: `Tool "${request.tool}" requires approval but no approval callback is set`,
        };
      }
      const approved = await this.approvalCallback(request.tool, request.args);
      if (!approved) {
        return {
          tool: request.tool,
          success: false,
          output: '',
          error: `User denied execution of "${request.tool}"`,
        };
      }
    }

    return null; // Permission granted
  }
}
