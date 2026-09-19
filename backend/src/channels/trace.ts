import type { Channel } from '../channel';
import type { ReactionName } from '../reactions';

/**
 * Development channel: delivers nothing.
 *
 * The Linq sandbox allows 100 messages a day and one agent turn is three or
 * four texts, so building the agent against the real channel would burn the
 * cap before the demo. The Durable Object writes `message_sent` trace events
 * for every channel alike, so the brain screen shows exactly what Snap would
 * have texted — only the delivery is skipped.
 */
export class TraceChannel implements Channel {
  readonly name = 'trace' as const;

  async send(_chatId: string, texts: string[]): Promise<Array<string | null>> {
    // Nothing is delivered, so there are no ids: the trace event is the point.
    return texts.map(() => null);
  }

  async react(_chatId: string, _reaction: ReactionName, _messageId: string | null): Promise<void> {
    // Same: the `reaction_sent` trace row is what the brain screen shows.
  }
}
