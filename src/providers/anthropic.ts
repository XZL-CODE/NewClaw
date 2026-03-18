/**
 * AnthropicProvider — Native Anthropic Messages API provider.
 *
 * Uses @anthropic-ai/sdk directly for full feature support
 * (tool_use, streaming, extended thinking, prompt caching).
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  LLMProvider,
  ProviderMessage,
  ChatOptions,
  ChatResponse,
  StreamChunk,
  ToolCall,
  ToolDef,
} from './types.js';

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic;

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async chat(messages: ProviderMessage[], options: ChatOptions): Promise<ChatResponse> {
    const { system, msgs } = this.splitSystem(messages, options.systemPrompt);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens,
      system: system || undefined,
      messages: msgs,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: options.temperature,
    });

    return this.parseResponse(response);
  }

  async *chatStream(messages: ProviderMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const { system, msgs } = this.splitSystem(messages, options.systemPrompt);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const stream = this.client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens,
      system: system || undefined,
      messages: msgs,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: options.temperature,
    });

    let textContent = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        const delta = event.delta as unknown as Record<string, unknown>;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          textContent += delta.text;
          yield { type: 'text_delta', text: delta.text };
        }
      }
    }

    const finalMessage = await stream.finalMessage();
    const response = this.parseResponse(finalMessage);

    // Yield any tool calls
    for (const tc of response.toolCalls) {
      yield { type: 'tool_call', toolCall: tc };
    }

    yield { type: 'done', response };
  }

  /** Extract system messages and convert to Anthropic format. */
  private splitSystem(
    messages: ProviderMessage[],
    systemPrompt?: string,
  ): { system: string; msgs: Anthropic.MessageParam[] } {
    const systemParts: string[] = [];
    if (systemPrompt) systemParts.push(systemPrompt);

    const msgs: Anthropic.MessageParam[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else {
        msgs.push({ role: m.role, content: m.content });
      }
    }

    return { system: systemParts.join('\n\n'), msgs };
  }

  /** Convert unified ToolDef[] to Anthropic Tool[] format. */
  private convertTools(tools: ToolDef[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
    }));
  }

  /** Parse Anthropic Message into unified ChatResponse. */
  private parseResponse(response: Anthropic.Message): ChatResponse {
    const textBlocks: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textBlocks.push(block.text);
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    const stopReasonMap: Record<string, ChatResponse['stopReason']> = {
      end_turn: 'end_turn',
      tool_use: 'tool_use',
      max_tokens: 'max_tokens',
    };

    return {
      content: textBlocks.join('\n').trim(),
      toolCalls,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: stopReasonMap[response.stop_reason ?? ''] ?? 'end_turn',
    };
  }
}
