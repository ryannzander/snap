/**
 * The reasoning seam.
 *
 * DESIGN.md picks OpenAI function calling, and that is what runs for the demo.
 * The interface exists so the rest of step 3 — context, tool dispatch, traces,
 * alarms — can be built and tested before an API key exists, and so a failing
 * model never takes the loop down with it.
 */

import type { ToolDefinition } from './agent/tools';

export interface BrainTurn {
  system: string;
  /** The rendered context block: goal, week, last 7 days, commitments, chat. */
  context: string;
  /** Why the agent is awake right now. */
  instruction: string;
  tools: ToolDefinition[];
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface BrainDecision {
  toolCalls: ToolCall[];
  /** Free text the model produced alongside its calls. Shown in the trace. */
  reasoning: string | null;
}

export interface Brain {
  readonly name: string;
  decide(turn: BrainTurn): Promise<BrainDecision>;
}
