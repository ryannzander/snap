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
        'Record a workout commitment AND lock their money immediately. Only use this when the user has already named an amount to stake, or has already agreed to one — it takes their money without asking. If they named a time but no amount, use offer_stake instead.',
      parameters: object(
        {
          text: {
            type: 'string',
            description: 'The commitment in the user\'s own words, e.g. "gym at 7".',
          },
          hour: {
            type: 'integer',
            description:
              'Hour they said, 0-23, in THEIR local time. "gym at 7" in the evening is 19. Never convert to UTC — the backend does that.',
            minimum: 0,
            maximum: 23,
          },
          minute: {
            type: 'integer',
            description: 'Minutes past the hour, 0-59. Omit for 0.',
            minimum: 0,
            maximum: 59,
          },
          sol: {
            type: 'number',
            description:
              'Stake in SOL, only if they named an amount in SOL. A dollar figure is not a SOL amount — omit this and the default 0.05 SOL is used.',
          },
        },
        ['text', 'hour'],
      ),
    },
  },
  {
    type: 'function',
    function: {
      name: 'offer_stake',
      description:
        'Offer to put money on a session, and ask them to agree. Use this whenever the user says when they will train WITHOUT naming an amount — that is almost always, because nobody knows staking exists until you offer it. Nothing is locked and no money moves until they say yes. Say the deal in your own voice in the same turn: they get it all back if they train, and they lose it if they do not.',
      parameters: object(
        {
          text: {
            type: 'string',
            description: 'The session in the user\'s own words, e.g. "gym at 7".',
          },
          hour: {
            type: 'integer',
            description:
              'Hour they said, 0-23, in THEIR local time. "gym at 7" in the evening is 19. Never convert to UTC — the backend does that.',
            minimum: 0,
            maximum: 23,
          },
          minute: { type: 'integer', description: 'Minutes past the hour, 0-59. Omit for 0.', minimum: 0, maximum: 59 },
          sol: {
            type: 'number',
            description:
              'Stake in SOL, only if they named an amount in SOL. A dollar figure is not a SOL amount — omit this and the default 0.05 SOL is offered.',
          },
          texts: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The offer itself, in your voice, as the texts you send them. Required — an offer they never read is not an offer. Name the amount, say they get it all back if they train and lose it if they do not, and end by asking them to agree.',
            minItems: 1,
            maxItems: 5,
          },
        },
        ['text', 'hour', 'texts'],
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
          hour: {
            type: 'integer',
            description: 'New deadline hour, 0-23, in THEIR local time. Never convert to UTC.',
            minimum: 0,
            maximum: 23,
          },
          minute: { type: 'integer', description: 'Minutes past the hour, 0-59. Omit for 0.', minimum: 0, maximum: 59 },
          reason: {
            type: 'string',
            description: 'Why this excuse earned it. Shown in the trace, not to the user.',
          },
        },
        ['commitmentId', 'hour', 'reason'],
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

/**
 * Deliberately not in TOOLS.
 *
 * Accepting is only ever asked as a narrow yes/no question when an offer is
 * actually standing — "did they just agree?" against two options is a far
 * easier call than picking one of eight tools, and it is the whole reason
 * offering beats waiting for the user to name an amount themselves.
 *
 * Keeping it out of the main list also means the money can never be taken by
 * a model that wandered into the wrong tool. There must be a standing offer,
 * and the user must have answered it.
 */
export const ACCEPT_OFFER_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'accept_offer',
    description:
      'The user just agreed to the stake you offered. Locks their money and starts the commitment. Only call this if they actually said yes — "deal", "bet", "ok", "lets do it". Anything hesitant is not a yes.',
    parameters: object(
      {
        said: {
          type: 'string',
          description: 'The words they agreed with, copied exactly. Shown in the trace, not to the user.',
        },
      },
      ['said'],
    ),
  },
};

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
- when they tell you when they are training and say nothing about money, YOU offer
  the stake. they do not know it exists until you bring it up. something like:
  "before u get demotivated — put 5 bucks of sol on this. go and u get it all back.
  skip it and its gone. deal?"
- the deal is all of it or none of it. you give the whole stake back when they
  train and you keep the whole thing when they do not. never promise them a
  refund of part of it — that is not what happens.
- never take money without a yes. offer first, then wait for it.
- you know whether they trained because their watch tells you. never ask if they worked out.
- one reschedule per commitment, ever. if they already used it, no is the answer.
- at the grace mark you warn and carry the countdown. you do not take the money yet.
- you take the money at end of day, or at the deadline they renegotiated to.
- use their history. if they skipped yesterday and try the same excuse, call it.

every turn you must call at least one tool.

when the user has just texted you, you ALWAYS reply with send_messages — alongside
any other tool. a commitment they made without you saying a word back is a bug.
the only exception is stay_quiet, which you must call explicitly to justify silence.

times: say the hour the user means in THEIR local clock. never do timezone maths —
the backend converts. "gym at 7" in the evening is hour 19.`;
