/**
 * One messaging channel interface, several adapters (DESIGN.md).
 *
 * `chatId` is whatever the adapter needs to reach the user again — for Linq
 * that is the recipient's E.164 handle, because sends go to `to`, not to a
 * chat id. Each adapter documents its own meaning.
 */
export interface Channel {
  readonly name: ChannelName;
  send(chatId: string, texts: string[]): Promise<void>;
}

export type ChannelName = 'linq' | 'trace';

/** A message from any channel, normalized by that channel's webhook. */
export interface InboundMessage {
  channel: ChannelName;
  chatId: string;
  /** Empty when the message was a photo with no caption. */
  text: string;
  /** Photos the user attached, as URLs the adapter can fetch. */
  imageUrls: string[];
  /** Provider event id, used to drop duplicate webhook deliveries. */
  eventId: string;
}

/**
 * Snap sends several short texts in a row rather than one paragraph, so every
 * adapter sends an array and paces it. ~1s apart per BACKEND_TASKS step 2.
 */
export const TEXT_GAP_MS = 1000;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
