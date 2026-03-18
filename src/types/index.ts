/**
 * NewClaw Core Types
 *
 * Design philosophy: minimal types, maximum model autonomy.
 * Types define boundaries, not behaviors.
 */

// ============================================================
// Event System
// ============================================================

export type EventSource =
  | 'user'        // User sent a message
  | 'webhook'     // External webhook (Sentry, GitHub, etc.)
  | 'file_watch'  // File system change
  | 'calendar'    // Calendar event
  | 'api_callback'// API callback
  | 'timer'       // One-shot timer (set by model, not cron)
  | 'mission'     // Autonomous mission execution
  | 'internal';   // Internal system event

export interface NewClawEvent {
  id: string;
  source: EventSource;
  channel: string;          // Which channel this came from
  timestamp: number;
  data: Record<string, unknown>;
  priority: 'critical' | 'normal' | 'low';
  metadata?: Record<string, unknown>;
}

// ============================================================
// Context Assembly
// ============================================================

export interface ContextWindow {
  identity: string;           // ~2k tokens: persona + user profile
  memories: MemoryItem[];     // ~5-20k tokens: relevant memories
  taskData: string;           // ~10-50k tokens: current event data
  tools: ToolDefinition[];    // ~3k tokens: available tools
  recentHistory: Message[];   // Last few turns for continuity
}

// ============================================================
// Model Reasoning
// ============================================================

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  channel?: string;
  toolCallId?: string;  // Links tool result to the originating tool_use
}

export interface ModelDecision {
  type: 'respond' | 'act' | 'silence';
  content?: string;            // Text response to user
  actions?: ActionRequest[];   // Tool calls to execute
  shouldRemember?: boolean;    // Model decides what to persist
  memoryNote?: string;         // What to remember about this interaction
}

export interface ActionRequest {
  tool: string;
  args: Record<string, unknown>;
  permissionLevel: PermissionLevel;
  toolCallId?: string;  // ID from the model's tool_use block, for result correlation
}

export interface ActionResult {
  tool: string;
  success: boolean;
  output: string;
  error?: string;
}

// ============================================================
// Tools
// ============================================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  permissionLevel: PermissionLevel;
}

export interface ToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required?: boolean;
}

export type ToolExecutor = (args: Record<string, unknown>) => Promise<ActionResult>;

// ============================================================
// Permission Boundary
// ============================================================

export enum PermissionLevel {
  FREE = 0,       // Read, search, think — no confirmation needed
  NOTIFY = 1,     // Write, safe bash — execute then notify user
  APPROVE = 2,    // Send external msgs, deploy — requires user approval
  FORBIDDEN = 3,  // Delete data, expose creds — hardcoded block
}

// ============================================================
// Memory Service
// ============================================================

export type MemoryLayer = 'fact' | 'episode' | 'reflection';

export interface MemoryItem {
  id: string;
  layer: MemoryLayer;
  content: string;
  tags: string[];
  embedding?: number[];
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  relevanceScore?: number;    // Set during retrieval
}

export interface MemoryQuery {
  text: string;               // Semantic search query
  layer?: MemoryLayer;        // Filter by layer
  tags?: string[];            // Filter by tags
  limit?: number;             // Max results (default 10)
  minRelevance?: number;      // Minimum similarity score
}

// ============================================================
// Channel Adapters
// ============================================================

export interface ChannelAdapter {
  name: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(to: string, content: string): Promise<void>;
  onMessage(handler: (event: NewClawEvent) => void): void;
  /** Optional: receive streaming text chunks for real-time display. */
  streamText?(chunk: string): void;
  /** Optional: send rich/structured messages (cards, posts, etc.). */
  sendRichMessage?(to: string, type: string, data: Record<string, unknown>): Promise<void>;
}

// ============================================================
// Configuration
// ============================================================

export interface NewClawConfig {
  // Provider (multi-LLM support)
  provider: string;                   // e.g. 'anthropic', 'deepseek', 'ollama', 'custom'
  apiKey: string;
  model: string;                      // e.g. 'claude-sonnet-4-20250514', 'deepseek-chat'
  maxTokens: number;
  baseUrl?: string;                   // Custom endpoint URL (overrides provider preset)

  // Identity
  persona: string;                    // Core personality description
  userProfile: string;                // Who the user is

  // Channels
  channels: ChannelConfig[];

  // Memory
  memoryDbPath: string;               // SQLite file path

  // Permissions
  permissions: PermissionConfig;

  // Webhook server
  webhookPort: number;

  // Web GUI port
  webPort?: number;

  // Quiet hours (model can override for critical events)
  quietHours?: { start: number; end: number };  // 24h format

  // Streaming mode: when true, MasterLoop uses reasonStream() for real-time output
  useStreaming?: boolean;

  // Max concurrent background tasks
  maxConcurrentTasks?: number;

  // Event filters (names of built-in filters to enable)
  eventFilters?: string[];

  // MCP Servers
  mcpServers?: McpServerEntry[];
}

export interface McpServerEntry {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ChannelConfig {
  type: 'terminal' | 'telegram' | 'discord' | 'feishu' | 'web';
  enabled: boolean;
  token?: string;
  options?: Record<string, unknown>;
}

export interface PermissionConfig {
  // Tools that require approval before execution
  approvalRequired: string[];
  // Tools that are completely forbidden
  forbidden: string[];
  // Auto-approve everything (dangerous, for dev only)
  autoApproveAll?: boolean;
}
