import { DurableObject } from 'cloudflare:workers';

import { newJoinCode, newLinkCode } from './ids';

/**
 * A single global Durable Object holding the link-code index.
 *
 * Pure plumbing, not a feature: `yo 4821` has to resolve to exactly one user,
 * and a 4-digit code drawn at random collides often enough that two people
 * onboarding at the demo could end up sharing one. This is the only place that
 * can check for that, because a per-user Durable Object cannot see its peers.
 */

const SINGLETON = 'v1';
const MAX_ATTEMPTS = 50;

/**
 * Wrong link codes one chat may try, and how long it is counted over.
 *
 * Ten is far more than a person fat-fingering a code off their own screen and
 * far fewer than ten thousand. Someone genuinely locked out waits an hour or
 * re-onboards for a fresh code.
 */
const MAX_LINK_ATTEMPTS = 10;
const LINK_ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

export class Directory extends DurableObject<Env> {
  /** Reserves an unused 4-digit code for `userId` and returns it. */
  async claimLinkCode(userId: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = newLinkCode();
      const key = `code:${code}`;
      if (await this.ctx.storage.get<string>(key)) continue;
      await this.ctx.storage.put(key, userId);
      return code;
    }
    throw new Error('could not allocate an unused link code');
  }

  /** Resolves `yo <code>` to a userId. */
  async lookupLinkCode(code: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`code:${code}`)) ?? null;
  }

  /** Remembers which user a chat belongs to, so later texts route without a code. */
  async bindChat(channel: string, chatId: string, userId: string): Promise<void> {
    await this.ctx.storage.put(`chat:${channel}:${chatId}`, userId);
  }

  async lookupChat(channel: string, chatId: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`chat:${channel}:${chatId}`)) ?? null;
  }

  /**
   * Releases a chat, but only if `userId` still owns it. The guard matters on a
   * reset: by the time the abandoned user stands down, the same thread may
   * already have been re-linked to the new one, and unbinding then would cut
   * the live thread loose instead of the dead one.
   */
  async releaseChat(channel: string, chatId: string, userId: string): Promise<void> {
    const key = `chat:${channel}:${chatId}`;
    if ((await this.ctx.storage.get<string>(key)) !== userId) return;
    await this.ctx.storage.delete(key);
  }

  /**
   * Spends a link code, once it has actually linked something.
   *
   * Codes used to live forever: `yo 4821` bound whoever sent it to that user,
   * and it kept working afterwards. Four digits is ten thousand guesses, there
   * was no limit on trying them, and a hit hands over somebody's thread — their
   * history, their open commitment, and a "deal" that moves their money.
   *
   * Only ever called after the user object has confirmed the link, so a bind
   * that fails halfway leaves the code usable rather than stranding someone
   * with a dead code and no way in.
   */
  async consumeLinkCode(code: string, userId: string): Promise<void> {
    const key = `code:${code}`;
    if ((await this.ctx.storage.get<string>(key)) !== userId) return;
    await this.ctx.storage.delete(key);
  }

  /**
   * How many wrong codes this chat is still allowed.
   *
   * Consuming codes stops a used one working twice; this is what stops the
   * guessing. A wrong code costs the sender an attempt and nothing else — no
   * reply, so it also tells them nothing about whether a code exists — and a
   * chat that has burned its attempts is ignored until the window rolls.
   *
   * Counted per chat rather than globally: a shared Directory means one
   * attacker must not be able to lock everybody else out of linking.
   */
  async spendLinkAttempt(channel: string, chatId: string): Promise<boolean> {
    const key = `tries:${channel}:${chatId}`;
    const now = Date.now();
    const seen = (await this.ctx.storage.get<number[]>(key)) ?? [];
    const recent = seen.filter((at) => at > now - LINK_ATTEMPT_WINDOW_MS);
    if (recent.length >= MAX_LINK_ATTEMPTS) {
      await this.ctx.storage.put(key, recent);
      return false;
    }
    await this.ctx.storage.put(key, [...recent, now]);
    return true;
  }

  /** A chat that linked successfully starts clean again. */
  async clearLinkAttempts(channel: string, chatId: string): Promise<void> {
    await this.ctx.storage.delete(`tries:${channel}:${chatId}`);
  }

  /** Frees a link code that was never used, so it can be drawn again. */
  async releaseLinkCode(code: string, userId: string): Promise<void> {
    const key = `code:${code}`;
    if ((await this.ctx.storage.get<string>(key)) !== userId) return;
    await this.ctx.storage.delete(key);
  }

  /** Reserves an unused join code for a competition and returns it. */
  async claimJoinCode(competitionId: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const code = newJoinCode();
      const key = `join:${code}`;
      if (await this.ctx.storage.get<string>(key)) continue;
      await this.ctx.storage.put(key, competitionId);
      return code;
    }
    throw new Error('could not allocate an unused join code');
  }

  /** Resolves a shared join code to a competition. */
  async lookupJoinCode(code: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`join:${code.trim().toUpperCase()}`)) ?? null;
  }

  /**
   * Webhook de-duplication. Linq retries deliveries, and a replayed `yo <code>`
   * would otherwise re-greet the user. Returns true the first time only.
   */
  async claimEvent(eventId: string): Promise<boolean> {
    const key = `event:${eventId}`;
    if (await this.ctx.storage.get(key)) return false;
    await this.ctx.storage.put(key, 1);
    return true;
  }
}

export function directoryStub(env: Env): DurableObjectStub<Directory> {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName(SINGLETON));
}
