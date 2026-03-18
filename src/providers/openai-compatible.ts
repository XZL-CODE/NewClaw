/**
 * OpenAICompatibleProvider — One class for all OpenAI-compatible LLM APIs.
 *
 * Works with: DeepSeek, Moonshot/Kimi, Qwen/DashScope, GLM/Zhipu,
 * Gemini, Ollama, LM Studio, vLLM, OpenRouter, SiliconFlow, OpenAI itself,
 * and any custom endpoint following the OpenAI Chat Completions format.
 */

import OpenAI from 'openai';
import type {
  LLMProvider,
  ProviderMessage,
  ChatOptions,
  ChatResponse,
  StreamChunk,
  ToolCall,
  ToolDef,
} from './types.js';

export class OpenAICompatibleProvider implements LLMProvider {
  readonly name: string;
  private client: OpenAI;

  constructor(name: string, baseURL: string, apiKey: string) {
    this.name = name;
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async chat(messages: ProviderMessage[], options: ChatOptions): Promise<ChatResponse> {
    const oaiMessages = this.buildMessages(messages, options.systemPrompt);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const response = await this.client.chat.completions.create({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: oaiMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: options.temperature,
    });

    return this.parseResponse(response);
  }

  async *chatStream(messages: ProviderMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    const oaiMessages = this.buildMessages(messages, options.systemPrompt);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    const stream = await this.client.chat.completions.create({
      model: options.model,
      max_tokens: options.maxTokens,
      messages: oaiMessages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: options.temperature,
      stream: true,
    });

    let content = '';
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();
    let totalToolCalls: ToolCall[] = [];
    let finishReason: string | null = null;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }

      const delta = choice.delta;

      // Text content
      if (delta.content) {
        content += delta.content;
        yield { type: 'text_delta', text: delta.content };
      }

      // Tool call deltas
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccum.has(idx)) {
            toolCallAccum.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
          }
          const accum = toolCallAccum.get(idx)!;
          if (tc.id) accum.id = tc.id;
          if (tc.function?.name) accum.name = tc.function.name;
          if (tc.function?.arguments) accum.args += tc.function.arguments;
        }
      }
    }

    // Finalize tool calls
    totalToolCalls = [...toolCallAccum.values()].map((tc) => ({
      id: tc.id,
      name: tc.name,
      arguments: safeParseJSON(tc.args),
    }));

    for (const tc of totalToolCalls) {
      yield { type: 'tool_call', toolCall: tc };
    }

    const stopReason = mapFinishReason(finishReason);

    yield {
      type: 'done',
      response: {
        content,
        toolCalls: totalToolCalls,
        usage: { inputTokens: 0, outputTokens: 0 }, // Usage not available in stream
        stopReason,
      },
    };
  }

  /** Prepend system prompt and convert messages to OpenAI format. */
  private buildMessages(
    messages: ProviderMessage[],
    systemPrompt?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const m of messages) {
      result.push({ role: m.role, content: m.content });
    }

    return result;
  }

  /** Convert unified ToolDef[] to OpenAI format. */
  private convertTools(tools: ToolDef[]): OpenAI.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      },
    }));
  }

  /** Parse non-streaming response. */
  private parseResponse(response: OpenAI.ChatCompletion): ChatResponse {
    const choice = response.choices[0];
    const message = choice?.message;

    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseJSON(tc.function.arguments),
    }));

    return {
      content: message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
      stopReason: mapFinishReason(choice?.finish_reason ?? null),
    };
  }
}

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function mapFinishReason(reason: string | null): ChatResponse['stopReason'] {
  switch (reason) {
    case 'stop': return 'end_turn';
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    default: return 'end_turn';
  }
}
