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
