/** Identifier, token and link-code generation. */

/** Unbiased URL-safe random string from `bytes` bytes of entropy. */
export function secret(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = '';
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Bearer token: `<userId>.<secret>`.
 *
 * Opaque to the client, but the Worker can read the userId off the front and
 * route straight to that user's Durable Object, which then compares the whole
 * token against the one it stored. Without this the Worker would need a second
 * round trip to a lookup table on every poll of /trace.
 */
export function issueToken(userId: string): string {
  return `${userId}.${secret()}`;
}

/** Splits a bearer token into its userId prefix. Null if it is not well formed. */
export function userIdFromToken(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const userId = token.slice(0, dot);
  return isUserId(userId) ? userId : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUserId(value: string): boolean {
  return UUID_RE.test(value);
}

export function newUserId(): string {
  return crypto.randomUUID();
}

/** Uniformly random 4-digit code, e.g. "4821" — rejection sampled, no modulo bias. */
export function newLinkCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 10_000) * 10_000;
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0]!;
  } while (n >= limit);
  return String(n % 10_000).padStart(4, '0');
}

/** Constant-time string comparison, so token checks do not leak length/prefix. */
export function secureEquals(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}
