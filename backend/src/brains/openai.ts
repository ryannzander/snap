import type { Brain, BrainDecision, BrainTurn, ToolCall } from '../brain';

/** OpenAI chat completions with function calling. DESIGN.md → "Agent brain". */

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export class OpenAIBrain implements Brain {
  readonly name = 'openai';

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async decide(turn: BrainTurn): Promise<BrainDecision> {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: turn.system },
          { role: 'user', content: `${turn.context}\n\n---\n\n${turn.instruction}` },
        ],
        tools: turn.tools,
        tool_choice: 'required',
        parallel_tool_calls: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`openai ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }

    const body = (await response.json()) as OpenAIResponse;
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error('openai returned no choices');

    const toolCalls: ToolCall[] = [];
    for (const call of message.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      // A model can emit malformed JSON; one bad call should not lose the rest.
      try {
        const parsed: unknown = JSON.parse(call.function.arguments || '{}');
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          toolCalls.push({ name: call.function.name, arguments: parsed as Record<string, unknown> });
        }
      } catch {
        continue;
      }
    }

    return { toolCalls, reasoning: message.content ?? null };
  }
}

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content: string | null;
      tool_calls?: Array<{
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
  }>;
}
