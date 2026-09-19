/**
 * Tapbacks — the cheapest thing two people can send each other.
 *
 * iMessage does not let you react with any emoji: there are six slots, and
 * every channel that carries them names them differently. This module is the
 * one place that knows the vocabulary, so the agent, the webhook and the
 * trace all mean the same thing by "😂".
 *
 * Pure functions, no I/O, so the whole vocabulary is testable without a
 * channel — which matters because a reaction Snap sends that the channel
 * silently drops looks identical to one nobody laughed at.
 */

/** The six slots iMessage actually has. */
export type ReactionName = 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question';

export const REACTIONS: Record<ReactionName, string> = {
  love: '❤️',
  like: '👍',
  dislike: '👎',
  laugh: '😂',
  emphasize: '‼️',
  question: '❓',
};

/**
 * Everything seen in the wild that means one of the six, including the
 * variation-selector-less forms phones send and the names Linq uses.
 *
 * A reaction that arrives as an emoji we cannot place is not an error — it is
 * a reaction we cannot name, and the agent still gets told it happened.
 */
const ALIASES: Record<string, ReactionName> = {
  love: 'love', heart: 'love', loved: 'love', '❤️': 'love', '❤': 'love', '♥️': 'love', '🩷': 'love',
  like: 'like', liked: 'like', thumbsup: 'like', thumbs_up: 'like', up: 'like', '👍': 'like', '👍🏻': 'like', '👍🏼': 'like', '👍🏽': 'like', '👍🏾': 'like', '👍🏿': 'like',
  dislike: 'dislike', disliked: 'dislike', thumbsdown: 'dislike', thumbs_down: 'dislike', down: 'dislike', '👎': 'dislike',
  laugh: 'laugh', laughed: 'laugh', haha: 'laugh', ha: 'laugh', lol: 'laugh', '😂': 'laugh', '🤣': 'laugh',
  emphasize: 'emphasize', emphasized: 'emphasize', exclaim: 'emphasize', '‼️': 'emphasize', '‼': 'emphasize', '❗': 'emphasize', '❗️': 'emphasize',
  question: 'question', questioned: 'question', '❓': 'question', '❔': 'question', '?': 'question',
};

/** Whatever the model or the channel called it, as one of the six — or null. */
export function toReaction(raw: unknown): ReactionName | null {
  if (typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (!key) return null;
  return ALIASES[key] ?? null;
}

/** The emoji for a name, for anything a person reads. */
export function reactionEmoji(name: ReactionName): string {
  return REACTIONS[name];
}

/**
 * A tapback that means yes.
 *
 * This is load-bearing: a 👍 on a standing offer takes the user's money, so
 * the set is deliberately the two that cannot be read any other way. 😂 is
 * not agreement — people laugh at an offer and then never train.
 */
export function isAffirmative(name: ReactionName): boolean {
  return name === 'like' || name === 'love';
}

/** A tapback that means no. Not the same as "not affirmative". */
export function isNegative(name: ReactionName): boolean {
  return name === 'dislike';
}

/** "👍 on: bro lock in" — one line for the trace and the model's context. */
export function describeReaction(emoji: string, targetText: string | null, removed = false): string {
  const verb = removed ? 'took back' : '';
  const target = targetText ? ` on: ${targetText}` : '';
  return removed ? `${emoji} ${verb}${target}`.replace('  ', ' ') : `${emoji}${target}`;
}
