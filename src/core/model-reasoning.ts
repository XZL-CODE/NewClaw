/**
 * ModelReasoning — LLM interaction layer.
 *
 * Translates a ContextWindow into a Provider API request,
 * streams the response, and parses it into a ModelDecision.
 * Provider-agnostic: works with Anthropic, OpenAI-compatible, or any LLMProvider.
 */

import type {
  LLMProvider,
  ProviderMessage,
  ChatOptions,
  ToolDef,
} from '../providers/types.js';
import type {
  ActionRequest,
  ContextWindow,
  ModelDecision,
  ToolDefinition,
} from '../types/index.js';

export class ModelReasoning {
  constructor(
    private provider: LLMProvider,
    private model: string,
    private maxTokens: number,
  ) {}

  /** Send context to the LLM and parse the response into a decision. */
  async reason(context: ContextWindow): Promise<ModelDecision> {
    const systemPrompt = this.buildSystemPrompt(context);
    const messages = this.buildMessages(context);
    const tools = this.buildToolDefs(context.tools);

    const response = await this.provider.chat(messages, {
      model: this.model,
      maxTokens: this.maxTokens,
      systemPrompt,
      tools: tools.length > 0 ? tools : undefined,
    });

    return this.parseResponse(response, context.tools);
  }

  /** Stream a reasoning response, yielding text chunks as they arrive. */
  async *reasonStream(context: ContextWindow): AsyncGenerator<{ type: 'text' | 'decision'; data: string | ModelDecision }> {
    const systemPrompt = this.buildSystemPrompt(context);
    const messages = this.buildMessages(context);
    const tools = this.buildToolDefs(context.tools);

    const stream = this.provider.chatStream(messages, {
      model: this.model,
      maxTokens: this.maxTokens,
      systemPrompt,
      tools: tools.length > 0 ? tools : undefined,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'text_delta') {
        yield { type: 'text', data: chunk.text };
      } else if (chunk.type === 'done') {
        const decision = this.parseResponse(chunk.response, context.tools);
        yield { type: 'decision', data: decision };
      }
    }
  }

  private buildSystemPrompt(context: ContextWindow): string {
    const parts = [context.identity];

    if (context.memories.length > 0) {
      const memoryBlock = context.memories
        .map((m) => `[${m.layer}] ${m.content}`)
        .join('\n');
      parts.push(`## Relevant Memories\n${memoryBlock}`);
    }

    parts.push(`## Current Task\n${context.taskData}`);

    return parts.join('\n\n');
  }

  private buildMessages(context: ContextWindow): ProviderMessage[] {
    return context.recentHistory.map((msg): ProviderMessage => ({
      // Map 'system' and 'tool' roles to 'user' for provider compatibility
      role: (msg.role === 'system' || msg.role === 'tool') ? 'user' : msg.role,
      content: msg.content,
    }));
  }

  private buildToolDefs(tools: ToolDefinition[]): ToolDef[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([key, param]) => [
              key,
              { type: param.type, description: param.description },
            ]),
          ),
          required: Object.entries(t.parameters)
            .filter(([, p]) => p.required)
            .map(([k]) => k),
        },
      },
    }));
  }

  private parseResponse(
    response: { content: string; toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>; stopReason: string },
    toolDefs: ToolDefinition[],
  ): ModelDecision {
    const actions: ActionRequest[] = response.toolCalls.map((tc) => {
      const toolDef = toolDefs.find((t) => t.name === tc.name);
      return {
        tool: tc.name,
        args: tc.arguments,
        permissionLevel: toolDef?.permissionLevel ?? 2, // Default to APPROVE if unknown
        toolCallId: tc.id, // Preserve for result correlation
      };
    });

    const content = response.content.trim();

    // Extract memory signals: if the model calls memory_write, treat it as shouldRemember
    const memoryAction = actions.find((a) => a.tool === 'memory_write');
    const shouldRemember = !!memoryAction;
    const memoryNote = memoryAction
      ? String(memoryAction.args.content ?? memoryAction.args.note ?? '')
      : undefined;

    if (actions.length > 0) {
      return { type: 'act', actions, content: content || undefined, shouldRemember, memoryNote };
    }
    if (content) {
      return { type: 'respond', content };
    }
    return { type: 'silence' };
  }
}
