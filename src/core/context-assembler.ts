/**
 * ContextAssembler — Build the minimal context window for each model call.
 *
 * Every invocation assembles a fresh context from identity, memory,
 * current event data, tool definitions, and a sliding window of
 * recent conversation history. No session state accumulates.
 */

import type {
  ContextWindow,
  MemoryItem,
  MemoryQuery,
  Message,
  NewClawConfig,
  NewClawEvent,
  ToolDefinition,
} from '../types/index.js';
import type { MissionStore } from '../mission/store.js';

/** External memory service interface — injected, not owned. */
export interface MemoryServiceInterface {
  query(q: MemoryQuery, userId?: string): MemoryItem[] | Promise<MemoryItem[]>;
  addEpisode(content: string, tags: string[], userId?: string): MemoryItem;
}

const DEFAULT_HISTORY_WINDOW = 10;
const DEFAULT_MEMORY_LIMIT = 15;

export class ContextAssembler {
  /** Per-user conversation history for multi-user isolation. */
  private historyMap: Map<string, Message[]> = new Map();
  /** Default (global) history for events without userId. */
  private globalHistory: Message[] = [];
  private historyWindow: number;

  private missionStore?: MissionStore;

  constructor(
    private config: NewClawConfig,
    private memoryService: MemoryServiceInterface,
    private historySize: number = DEFAULT_HISTORY_WINDOW,
  ) {
    this.historyWindow = historySize;
  }

  /** Inject MissionStore for active mission context. */
  setMissionStore(store: MissionStore): void {
    this.missionStore = store;
  }

  /** Assemble a full context window for the current event. */
  async assemble(event: NewClawEvent, tools: ToolDefinition[]): Promise<ContextWindow> {
    const identity = this.buildIdentity();
    const userId = this.extractUserId(event);
    const memories = await this.retrieveMemories(event, userId);
    const taskData = this.buildTaskData(event);

    return {
      identity,
      memories,
      taskData,
      tools,
      recentHistory: this.getRecentHistory(userId),
    };
  }

  /** Add a message to the sliding history window, with optional per-user isolation. */
  addToHistory(message: Message, userId?: string): void {
    const history = this.getHistoryArray(userId);
    history.push(message);

    if (history.length > this.historyWindow * 2) {
      // Summarize the messages about to be discarded, then trim
      const discarded = history.slice(0, history.length - this.historyWindow);
      this.summarizeAndStore(discarded, userId);

      // Keep only the most recent messages
      const trimmed = history.slice(-this.historyWindow);
      if (userId) {
        this.historyMap.set(userId, trimmed);
      } else {
        this.globalHistory.splice(0, this.globalHistory.length, ...trimmed);
      }
    }
  }

  /** Clear conversation history for a specific user, or all if no userId. */
  clearHistory(userId?: string): void {
    if (userId) {
      this.historyMap.delete(userId);
    } else {
      this.globalHistory = [];
      this.historyMap.clear();
    }
  }

  /** Summarize discarded messages and store as an episode memory (no LLM call). */
  private summarizeAndStore(messages: Message[], userId?: string): void {
    if (messages.length === 0) return;

    // Simple summarization: extract key content from each message
    const summaryParts: string[] = [];
    for (const msg of messages) {
      const preview = msg.content.slice(0, 200);
      summaryParts.push(`[${msg.role}] ${preview}`);
    }

    const summary = `[对话摘要 ${new Date().toISOString()}] ${messages.length}条消息:\n${summaryParts.join('\n')}`;

    this.memoryService.addEpisode(
      summary,
      ['auto-summary', 'conversation'],
      userId,
    );
  }

  private buildIdentity(): string {
    const sections = [
      `## Persona\n${this.config.persona}`,
      `## User Profile\n${this.config.userProfile}`,
    ];

    if (this.missionStore) {
      const summary = this.missionStore.getActiveMissionsSummary();
      if (summary) {
        sections.push(`## 当前活跃的自主任务\n${summary}`);
        sections.push(
          `## 重要行为约束\n` +
          `你正在执行自主任务。即使用户主动跟你对话，你也必须：\n` +
          `- 保持自主代理角色，不要变回普通助手\n` +
          `- 不要向用户提问或请求指示\n` +
          `- 如果用户问你在干什么，直接准确汇报 Mission 进度\n` +
          `- 不要道歉，不要说"有什么想让我优先处理的吗"\n` +
          `- 继续按 Mission 目标自主执行`
        );
      }
    }

    return sections.join('\n\n');
  }

  private async retrieveMemories(event: NewClawEvent, userId?: string): Promise<MemoryItem[]> {
    const queryText = typeof event.data.text === 'string'
      ? event.data.text
      : JSON.stringify(event.data).slice(0, 500);

    return this.memoryService.query({
      text: queryText,
      limit: DEFAULT_MEMORY_LIMIT,
      minRelevance: 0.3,
    }, userId);
  }

  private buildTaskData(event: NewClawEvent): string {
    const parts = [
      `Source: ${event.source}`,
      `Channel: ${event.channel}`,
      `Priority: ${event.priority}`,
      `Time: ${new Date(event.timestamp).toISOString()}`,
      `\nEvent Data:\n${JSON.stringify(event.data, null, 2)}`,
    ];
    return parts.join('\n');
  }

  private extractUserId(event: NewClawEvent): string | undefined {
    const uid = event.data.userId;
    return typeof uid === 'string' ? uid : undefined;
  }

  private getHistoryArray(userId?: string): Message[] {
    if (!userId) return this.globalHistory;
    let history = this.historyMap.get(userId);
    if (!history) {
      history = [];
      this.historyMap.set(userId, history);
    }
    return history;
  }

  private getRecentHistory(userId?: string): Message[] {
    const history = this.getHistoryArray(userId);
    return history.slice(-this.historyWindow);
  }
}
