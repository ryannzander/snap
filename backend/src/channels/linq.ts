import { TEXT_GAP_MS, sleep, type Channel, type InboundMessage, type InboundReaction } from '../channel';
import { reactionEmoji, toReaction, type ReactionName } from '../reactions';

/**
 * Linq adapter — real iMessage. https://docs.linqapp.com/channel/imessage
 *
 * `chatId` here is the recipient's E.164 handle: v3 sends take `to` and
 * deliberately omit `from` so Linq load-balances across the line pool and
 * fails over off a flagged line on its own.
 */

const API_BASE = 'https://api.linqapp.com/api/partner/v3';

/** Replay window for webhook signatures, per the Standard Webhooks spec. */
const SIGNATURE_MAX_AGE_SEC = 300;

export class LinqChannel implements Channel {
  readonly name = 'linq' as const;

  constructor(private readonly apiKey: string) {}

  async send(chatId: string, texts: string[]): Promise<Array<string | null>> {
    const ids: Array<string | null> = [];

    for (const [index, text] of texts.entries()) {
      // Snap texts in bursts; pace them so they land like someone typing.
      if (index > 0) await sleep(TEXT_GAP_MS);

      const response = await fetch(`${API_BASE}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: [chatId],
          message: { parts: [{ type: 'text', value: text }] },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        // 403 with code 2024 is a keyword opt-out. Never retry it.
        throw new Error(`linq send failed: ${response.status} ${body.slice(0, 300)}`);
      }

      ids.push(await sentMessageId(response));
    }

    return ids;
  }

  /**
   * Tapback one of their messages.
   *
   * Deliberately never throws. A tapback is the one thing Snap sends that is
   * pure texture: if the line, the payload version or the recipient's device
   * will not carry it, the turn it decorates must still land. The trace event
   * is written by the caller either way, so the brain screen shows what Snap
   * meant even when the channel dropped it.
   *
   * Sent as a `reaction` part naming the target message, which is the shape
   * the v3 message payload uses for everything that is not text or media. A
   * reaction with no target has nothing to attach to and is skipped rather
   * than sent as a bare emoji text — a stray "👍" in the thread reads as Snap
   * losing the plot.
   */
  async react(chatId: string, reaction: ReactionName, messageId: string | null): Promise<void> {
    if (!messageId) return;

    try {
      const response = await fetch(`${API_BASE}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: [chatId],
          message: {
            parts: [
              {
                type: 'reaction',
                value: reaction,
                emoji: reactionEmoji(reaction),
                target_message_id: messageId,
              },
            ],
          },
        }),
      });
      if (!response.ok) {
        const body = await response.text();
        console.error(`linq reaction not delivered: ${response.status} ${body.slice(0, 200)}`);
      }
    } catch (error) {
      console.error('linq reaction failed', String(error).slice(0, 200));
    }
  }
}

/**
 * The id Linq gave the message it just accepted, or null.
 *
 * Best effort by design: the id is only used to label a tapback on that text
 * later, so a payload shape we cannot read costs a caption, not a message. A
 * body that will not even parse is not worth failing a delivered send over.
 */
async function sentMessageId(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const data = (body.data ?? body) as Record<string, unknown>;
    if (typeof data.id === 'string') return data.id;
    const messages = data.messages ?? data.message;
    if (Array.isArray(messages)) {
      const first = messages[0];
      if (typeof first === 'object' && first !== null) {
        const id = (first as Record<string, unknown>).id;
        if (typeof id === 'string') return id;
      }
    }
    if (typeof messages === 'object' && messages !== null) {
      const id = (messages as Record<string, unknown>).id;
      if (typeof id === 'string') return id;
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetches a line to show a new user, plus its contact card. */
export async function availableNumber(
  apiKey: string,
): Promise<{ handle: string | null; vcfUrl: string | null }> {
  const response = await fetch(`${API_BASE}/available_number`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return { handle: null, vcfUrl: null };

  const body = (await response.json()) as Record<string, unknown>;
  const data = (body.data ?? body) as Record<string, unknown>;
  return {
    handle: typeof data.phone_number === 'string' ? data.phone_number : null,
    vcfUrl: typeof data.vcf_url === 'string' ? data.vcf_url : null,
  };
}

/**
 * Standard Webhooks signature check.
 * HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{rawBody}`, compared
 * against each `v1,<base64>` in the header.
 */
export async function verifySignature(
  headers: Headers,
  rawBody: string,
  signingSecret: string,
  nowMs: number,
): Promise<boolean> {
  const id = headers.get('webhook-id');
  const timestamp = headers.get('webhook-timestamp');
  const signatures = headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) return false;

  const sentAt = Number(timestamp);
  if (!Number.isFinite(sentAt)) return false;
  if (Math.abs(nowMs / 1000 - sentAt) > SIGNATURE_MAX_AGE_SEC) return false;

  const keyBytes = base64ToBytes(signingSecret.replace(/^whsec_/, ''));
  if (!keyBytes) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${rawBody}`),
  );
  const expected = bytesToBase64(new Uint8Array(mac));

  // The header may carry several signatures during a secret rotation.
  return signatures
    .split(' ')
    .some((entry) => constantTimeEquals(entry.split(',')[1] ?? '', expected));
}

/**
 * Pulls `{ channel, chatId, text, imageUrls }` out of a webhook body.
 * Returns null for any event that is not an inbound message with at least a
 * text part or a photo.
 *
 * Handles both the current payload (`data.chat.id` + `sender_handle`) and the
 * older `2025-01-01` shape (`data.chat_id` + `from`), since the sandbox
 * subscription may be pinned to either.
 */
export function normalizeInbound(body: unknown): InboundMessage | null {
  if (typeof body !== 'object' || body === null) return null;
  const envelope = body as Record<string, unknown>;

  const eventType = String(envelope.event_type ?? envelope.event ?? '');
  if (!INBOUND_EVENTS.has(eventType)) return null;

  const data = envelope.data;
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;

  if (message.direction !== undefined && message.direction !== 'inbound') return null;

  const handle = senderHandle(message);
  if (!handle) return null;

  const text = textFromParts(message.parts) ?? '';
  const imageUrls = imageUrlsFromParts(message.parts);
  const reaction = reactionFrom(envelope, message, eventType);
  if (text === '' && imageUrls.length === 0 && !reaction) return null;

  const messageId = typeof message.id === 'string' ? message.id : null;
  const eventId =
    typeof envelope.event_id === 'string'
      ? envelope.event_id
      : messageId
        ? // A removed tapback carries the same message id as the one that
          // added it; without the suffix the removal looks like a duplicate
          // delivery of the reaction and is dropped.
          `${messageId}${reaction ? `:${reaction.emoji}${reaction.removed ? ':off' : ''}` : ''}`
        : `${handle}:${text || imageUrls[0] || reaction?.emoji}`;

  return { channel: 'linq', chatId: handle, text, imageUrls, eventId, messageId, ...(reaction ? { reaction } : {}) };
}

/** Message deliveries, and the tapback events that ride the same webhook. */
const INBOUND_EVENTS = new Set([
  'message.received',
  'message.reaction',
  'message.reaction.received',
  'reaction.received',
  'reaction.removed',
]);

/**
 * The tapback in a delivery, or null when it is an ordinary message.
 *
 * Linq has carried reactions as their own event type and as a part inside a
 * normal message delivery depending on payload version, so both are read.
 * An emoji we cannot place in the six iMessage slots still comes back with
 * `name: null` — Snap should hear that they reacted even when we cannot say
 * which tapback it was.
 */
function reactionFrom(
  envelope: Record<string, unknown>,
  message: Record<string, unknown>,
  eventType: string,
): InboundReaction | null {
  const fromEvent = eventType !== 'message.received';
  const part = reactionPart(message.parts);
  const payload =
    part ??
    (typeof message.reaction === 'object' && message.reaction !== null
      ? (message.reaction as Record<string, unknown>)
      : fromEvent
        ? message
        : null);
  if (!payload) return null;

  const raw =
    firstString(payload, ['value', 'reaction', 'emoji', 'name', 'type_name', 'kind']) ?? '';
  const name = toReaction(raw);
  const emoji = name ? reactionEmoji(name) : raw;
  if (!emoji) return null;

  const removed =
    eventType === 'reaction.removed' ||
    payload.removed === true ||
    payload.is_removed === true ||
    envelope.removed === true ||
    String(payload.action ?? '') === 'removed';

  return {
    name,
    emoji,
    targetMessageId: firstString(payload, [
      'target_message_id',
      'message_id',
      'targetMessageId',
      'in_reply_to',
      'associated_message_id',
    ]),
    removed,
  };
}

/** The first `reaction`/`tapback` part of a message, if it has one. */
function reactionPart(parts: unknown): Record<string, unknown> | null {
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const entry = part as Record<string, unknown>;
    if (!REACTION_PART_TYPES.has(String(entry.type ?? ''))) continue;
    // `value` is a bare string on some versions and an object on others.
    if (typeof entry.value === 'object' && entry.value !== null) {
      return { ...(entry.value as Record<string, unknown>), ...entry, value: undefined };
    }
    return entry;
  }
  return null;
}

const REACTION_PART_TYPES = new Set(['reaction', 'tapback', 'associated_message']);

function senderHandle(message: Record<string, unknown>): string | null {
  const sender = message.sender_handle ?? message.from_handle;
  if (typeof sender === 'object' && sender !== null) {
    const handle = (sender as Record<string, unknown>).handle;
    if (typeof handle === 'string' && handle.length > 0) return handle;
  }
  if (typeof message.from === 'string' && message.from.length > 0) return message.from;
  return null;
}

/**
 * The photos in a message, as fetchable URLs.
 *
 * Linq's part shape for media has moved between payload versions, so this
 * reads every form seen so far: a part typed `image`/`attachment`/`media`/
 * `file` whose `value` is a URL string, or an object carrying `url`,
 * `media_url` or `src`. Anything with a mime type that is not `image/*` is
 * skipped — a PDF is not a gym selfie.
 */
export function imageUrlsFromParts(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const urls: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const entry = part as Record<string, unknown>;
    if (entry.type === 'text') continue;
    if (!MEDIA_PART_TYPES.has(String(entry.type ?? ''))) continue;

    const payload =
      typeof entry.value === 'object' && entry.value !== null
        ? (entry.value as Record<string, unknown>)
        : entry;
    const mime = firstString(payload, ['mime_type', 'content_type', 'mimeType', 'contentType']);
    if (mime && !mime.toLowerCase().startsWith('image/')) continue;

    const url =
      typeof entry.value === 'string'
        ? entry.value
        : firstString(payload, ['url', 'media_url', 'src', 'href']);
    if (url && /^https?:\/\//i.test(url)) urls.push(url);
  }
  return urls;
}

const MEDIA_PART_TYPES = new Set(['image', 'attachment', 'media', 'file', 'photo', 'picture']);

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** Joins the text parts; a message with no text part (media only) yields null. */
function textFromParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const pieces: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'object' || part === null) continue;
    const entry = part as Record<string, unknown>;
    if (entry.type === 'text' && typeof entry.value === 'string') pieces.push(entry.value);
  }
  return pieces.length > 0 ? pieces.join('\n') : null;
}

// --- helpers ---------------------------------------------------------------

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
