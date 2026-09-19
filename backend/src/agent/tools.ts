/**
 * The agent's tools (BACKEND_TASKS step 3), in OpenAI function-calling shape.
 *
 * The rules these encode come from DESIGN.md → "Stake rules": 0.05 SOL unless
 * the user names an amount, 20 minutes of grace, at most one renegotiation
 * per commitment, a warning at grace rather than a slash, and the slash at end
 * of day or at the renegotiated deadline.
 */

export const DEFAULT_STAKE_LAMPORTS = 50_000_000; // 0.05 SOL
export const DEFAULT_GRACE_MIN = 20;
export const MAX_RENEGOTIATIONS = 1;

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const object = (
  properties: Record<string, unknown>,
  required: string[],
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'create_commitment',
      description:
        'Record a new workout commitment the user just made, and lock their stake. Use this the moment they say when they will train.',
      parameters: object(
        {
          text: {
            type: 'string',
            description: 'The commitment in the user\'s own words, e.g. "gym at 7".',
          },
          dueAt: {
            type: 'string',
            description: 'ISO 8601 UTC time the workout should have happened by.',
          },
          lamports: {
            type: 'integer',
            description: `Stake in lamports. Omit for the default ${DEFAULT_STAKE_LAMPORTS} (0.05 SOL). Only set it if they named an amount.`,
          },
        },
        ['text', 'dueAt'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'reschedule_commitment',
      description:
        'Move an existing commitment to a new deadline because the user talked you into it. The stake does not change. Only one reschedule is allowed per commitment, ever — if it has already been rescheduled, refuse and say so instead.',
      parameters: object(
        {
          commitmentId: { type: 'string' },
          dueAt: { type: 'string', description: 'The new deadline, ISO 8601 UTC.' },
          reason: {
            type: 'string',
            description: 'Why this excuse earned it. Shown in the trace, not to the user.',
          },
        },
        ['commitmentId', 'dueAt', 'reason'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_messages',
      description:
        'Text the user. Several short messages in a row, never a paragraph. Lowercase, gym-bro voice.',
      parameters: object(
        {
          texts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Each element is one text message, sent about a second apart.',
            minItems: 1,
            maxItems: 5,
          },
        },
        ['texts'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'stay_quiet',
      description:
        'Decide not to text at all. Use this when texting would be nagging — you already messaged recently, or nothing has changed since last time.',
      parameters: object(
        { reason: { type: 'string', description: 'Why silence is the right call.' } },
        ['reason'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'release_stake',
      description:
        'Give the money back. Only when a workout covering the commitment has actually been detected from HealthKit.',
      parameters: object({ commitmentId: { type: 'string' } }, ['commitmentId']),
    },
  },
  {
    type: 'function',
    function: {
      name: 'slash_stake',
      description:
        'Take the money. Only at end of day, or at a renegotiated deadline that has passed with no workout. Never at the grace mark — that is a warning, not a slash.',
      parameters: object({ commitmentId: { type: 'string' } }, ['commitmentId']),
    },
  },
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.function.name);

/** Snap's persona. DESIGN.md → "Voice", and BACKEND_TASKS → "The voice". */
export const SYSTEM_PROMPT = `you are snap, the user's gym bro. you live in their text thread.

voice:
- lowercase. short. several texts in a row, never a paragraph.
- "bro", "nah", "😭", "lock in". funny, not mean.
- you negotiate ("30 mins then. push day. go.") rather than lecture.
- you never sound like an assistant and you never explain yourself.
- never mention tools, commitments as "records", or that you are an AI.

how you work:
- the user's money is on the line. that is the whole point. reference it.
- you know whether they trained because their watch tells you. never ask if they worked out.
- one reschedule per commitment, ever. if they already used it, no is the answer.
- at the grace mark you warn and carry the countdown. you do not take the money yet.
- you take the money at end of day, or at the deadline they renegotiated to.
- use their history. if they skipped yesterday and try the same excuse, call it.

every turn you must call at least one tool. if the right move is silence, call stay_quiet.`;
