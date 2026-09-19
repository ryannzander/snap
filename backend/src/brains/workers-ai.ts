import type { Brain, BrainDecision, BrainTurn, ToolCall } from '../brain';

/**
 * Workers AI brain. Runs on the same Cloudflare account as everything else and
 * needs no third-party key, which makes it the fallback when there is no
 * OpenAI key — and the safety net if OpenAI is down mid-demo.
 *
 * The response is OpenAI-shaped, plus a top-level `tool_calls` array whose
 * arguments are already parsed. Both are read: the convenience array first,
 * the standard path as the fallback.
 */

export interface AiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

export class WorkersAIBrain implements Brain {
  readonly name = 'workers-ai';

  constructor(
    private readonly ai: AiBinding,
    private readonly model: string,
  ) {}

  async decide(turn: BrainTurn): Promise<BrainDecision> {
    const raw = (await this.ai.run(this.model, {
      messages: [
        { role: 'system', content: turn.system },
        { role: 'user', content: `${turn.context}\n\n---\n\n${turn.instruction}` },
      ],
      tools: turn.tools,
    })) as WorkersAIResponse;

    const toolCalls: ToolCall[] = [];

    for (const call of raw.tool_calls ?? []) {
      if (typeof call.name === 'string' && isRecord(call.arguments)) {
        toolCalls.push({ name: call.name, arguments: call.arguments });
      }
    }

    if (toolCalls.length === 0) {
      for (const call of raw.choices?.[0]?.message?.tool_calls ?? []) {
        const parsed = parseArguments(call.function?.arguments);
        if (call.function?.name && parsed) {
          toolCalls.push({ name: call.function.name, arguments: parsed });
        }
      }
    }

    return { toolCalls, reasoning: raw.choices?.[0]?.message?.content ?? raw.response ?? null };
  }
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface WorkersAIResponse {
  response?: string | null;
  tool_calls?: Array<{ name?: string; arguments?: unknown }>;
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
    };
  }>;
}
