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

/**
 * A shareable competition code: six characters, no vowels and no 0/1/I/O, so
 * it survives being read aloud in a gym or typed from a screenshot.
 */
export function newJoinCode(): string {
  const alphabet = '23456789BCDFGHJKLMNPQRSTVWXYZ';
  // Rejection sampled, like `newLinkCode` above and for the same reason: 256
  // does not divide 29, so `byte % 29` handed the first 24 characters nine of
  // the 256 bytes each and the last five only eight — every code was 12.5%
  // more likely to start with a 2 than a Z. Not an attack on a join code, but
  // the function three above this one documents the fix, which makes this the
  // kind of inconsistency that is worth two minutes now and an argument later.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const buf = new Uint8Array(1);
  let code = '';
  while (code.length < 6) {
    crypto.getRandomValues(buf);
    if (buf[0]! >= limit) continue;
    code += alphabet[buf[0]! % alphabet.length];
  }
  return code;
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
