import type { ReactionName } from './reactions';

/**
 * One messaging channel interface, several adapters (DESIGN.md).
 *
 * `chatId` is whatever the adapter needs to reach the user again — for Linq
 * that is the recipient's E.164 handle, because sends go to `to`, not to a
 * chat id. Each adapter documents its own meaning.
 */
export interface Channel {
  readonly name: ChannelName;
  /**
   * Sends the burst and returns the provider's id for each text, in order, with
   * null where the provider did not say. The ids are what an inbound tapback
   * names, so without them a reaction on one of Snap's texts can only be shown
   * as a bare emoji with nothing to point at.
   */
  send(chatId: string, texts: string[]): Promise<Array<string | null>>;
  /**
   * Tapback one of their messages. `messageId` is the provider's id for the
   * message being reacted to; without one there is nothing to attach to, so
   * the adapter is free to do nothing.
   */
  react(chatId: string, reaction: ReactionName, messageId: string | null): Promise<void>;
}

export type ChannelName = 'linq' | 'trace';

/** A message from any channel, normalized by that channel's webhook. */
export interface InboundMessage {
  channel: ChannelName;
  chatId: string;
  /** Empty when the message was a photo with no caption, or a bare reaction. */
  text: string;
  /** Photos the user attached, as URLs the adapter can fetch. */
  imageUrls: string[];
  /** Provider event id, used to drop duplicate webhook deliveries. */
  eventId: string;
  /** The provider's id for this message, so Snap can tapback the right one. */
  messageId: string | null;
  /** Set when this delivery is a tapback rather than a message of its own. */
  reaction?: InboundReaction;
}

export interface InboundReaction {
  /** One of the six slots, when we could place it. */
  name: ReactionName | null;
  /** What they actually sent, for the trace — an unplaceable emoji still shows. */
  emoji: string;
  /** The message they reacted to, when the provider said which. */
  targetMessageId: string | null;
  /** iMessage lets you remove a tapback; that arrives as its own event. */
  removed: boolean;
}

/**
 * Snap sends several short texts in a row rather than one paragraph, so every
 * adapter sends an array and paces it. ~1s apart per BACKEND_TASKS step 2.
 */
export const TEXT_GAP_MS = 1000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
