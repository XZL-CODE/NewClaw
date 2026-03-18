/**
 * McpClient — Connect to an MCP Server via stdio (JSON-RPC 2.0).
 *
 * Spawns a child process and communicates over stdin/stdout.
 * Discovers server tools and converts them to NewClaw ToolDefinitions.
 */

import { spawn, type ChildProcess } from 'child_process';
import type { ActionExecutor } from '../core/action-executor.js';
import type { ToolDefinition, ToolParameter, ActionResult } from '../types/index.js';
import { PermissionLevel } from '../types/index.js';
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  McpInitializeResult,
  McpToolsListResult,
  McpToolCallResult,
  McpToolDefinition,
  McpServerConfig,
} from './types.js';

export class McpClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, {
    resolve: (value: JsonRpcResponse) => void;
    reject: (reason: Error) => void;
  }>();
  private buffer = '';
  private serverName: string;
  private tools: McpToolDefinition[] = [];

  constructor(private config: McpServerConfig) {
    this.serverName = config.name;
  }

  /** Connect to the MCP server, initialize, and discover tools. */
  async connect(): Promise<McpToolDefinition[]> {
    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
    });

    this.process.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.stderr!.on('data', (chunk: Buffer) => {
      console.error(`[MCP:${this.serverName}] stderr:`, chunk.toString());
    });
    this.process.on('exit', (code) => {
      console.log(`[MCP:${this.serverName}] process exited with code ${code}`);
      this.rejectAll(new Error(`MCP server "${this.serverName}" exited with code ${code}`));
    });

    // Initialize handshake
    await this.sendRequest<McpInitializeResult>('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'newclaw', version: '0.1.0' },
    });

    // Send initialized notification (no id, no response expected)
    this.sendNotification('notifications/initialized');

    // Discover tools
    const result = await this.sendRequest<McpToolsListResult>('tools/list', {});
    this.tools = result.tools ?? [];

    console.log(`[MCP:${this.serverName}] Connected, ${this.tools.length} tool(s) available`);
    return this.tools;
  }

  /** Call a tool on the MCP server. */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    return this.sendRequest<McpToolCallResult>('tools/call', {
      name,
      arguments: args,
    });
  }

  /** Convert MCP tools to NewClaw ToolDefinitions and register them on the executor. */
  registerTools(executor: ActionExecutor): void {
    for (const mcpTool of this.tools) {
      const def = this.toToolDefinition(mcpTool);
      const executorFn = this.createExecutor(mcpTool.name);
      executor.registerTool(def.name, def, executorFn);
    }
  }

  /** Disconnect from the MCP server. */
  disconnect(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.rejectAll(new Error('Client disconnected'));
  }

  // ── Private ──────────────────────────────────────────────

  private toToolDefinition(mcpTool: McpToolDefinition): ToolDefinition {
    const parameters: Record<string, ToolParameter> = {};
    const props = mcpTool.inputSchema?.properties ?? {};
    const required = new Set(mcpTool.inputSchema?.required ?? []);

    for (const [key, schema] of Object.entries(props)) {
      const paramType = schema.type as ToolParameter['type'];
      parameters[key] = {
        type: ['string', 'number', 'boolean', 'object', 'array'].includes(paramType) ? paramType : 'string',
        description: schema.description ?? '',
        required: required.has(key),
      };
    }

    return {
      name: `mcp_${this.serverName}_${mcpTool.name}`,
      description: mcpTool.description ?? `MCP tool from ${this.serverName}`,
      parameters,
      permissionLevel: PermissionLevel.APPROVE, // MCP tools default to requiring approval
    };
  }

  private createExecutor(toolName: string): (args: Record<string, unknown>) => Promise<ActionResult> {
    const registeredName = `mcp_${this.serverName}_${toolName}`;
    return async (args) => {
      try {
        const result = await this.callTool(toolName, args);
        const text = result.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text!)
          .join('\n');
        return {
          tool: registeredName,
          success: !result.isError,
          output: text || '(no output)',
          error: result.isError ? text : undefined,
        };
      } catch (err) {
        return {
          tool: registeredName,
          success: false,
          output: '',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    };
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
    this.process?.stdin?.write(msg);
  }

  private sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = ++this.requestId;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (resp) => {
          if (resp.error) {
            reject(new Error(`MCP error ${resp.error.code}: ${resp.error.message}`));
          } else {
            resolve(resp.result as T);
          }
        },
        reject,
      });
      const msg = JSON.stringify(request) + '\n';
      this.process?.stdin?.write(msg);
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const handler = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          handler.resolve(msg);
        }
      } catch {
        // Ignore non-JSON lines (e.g. server logging to stdout)
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const handler of this.pending.values()) {
      handler.reject(error);
    }
    this.pending.clear();
  }
}
