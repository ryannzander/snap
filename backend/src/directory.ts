import { DurableObject } from 'cloudflare:workers';

import { newLinkCode } from './ids';

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

  /** Resolves `yo <code>` to a userId. Used by the channel webhooks in step 2. */
  async lookupLinkCode(code: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(`code:${code}`)) ?? null;
  }
}

export function directoryStub(env: Env): DurableObjectStub<Directory> {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName(SINGLETON));
}
