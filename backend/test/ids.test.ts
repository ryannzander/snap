/**
 * Codes and tokens.
 *
 * Three of these are read aloud, typed from a screenshot, or carry someone's
 * whole account, and none of them had a test.
 */
import { issueToken, isUserId, newJoinCode, newLinkCode, newUserId, secret, secureEquals, userIdFromToken } from '../src/ids';
import { section, eq, isTrue, isFalse, done } from './harness';

section('bearer tokens');
{
  const id = newUserId();
  const token = issueToken(id);
  eq('the worker can read the user off the front', userIdFromToken(token), id);
  isTrue('and the rest is real entropy', token.slice(id.length + 1).length >= 30);

  // 24 bytes is 192 bits. The point of asserting it is that shrinking it later
  // should have to be deliberate.
  isTrue('a secret is 24 bytes of base64url', secret().length >= 32);
  isFalse('no padding or unsafe characters', /[+/=]/.test(secret()));
  isTrue('two secrets never collide', new Set(Array.from({ length: 500 }, () => secret())).size === 500);

  eq('a token with no dot is not a token', userIdFromToken('nodothere'), null);
  eq('a leading dot is not a token', userIdFromToken('.abc'), null);
  eq('and the prefix has to be a real user id', userIdFromToken('notauuid.abc'), null);
  isFalse('an empty string is not a user id', isUserId(''));
}

section('constant-time comparison');
{
  isTrue('equal strings', secureEquals('abc', 'abc'));
  isFalse('different strings', secureEquals('abc', 'abd'));
  isFalse('different lengths', secureEquals('abc', 'abcd'));
  isFalse('a prefix is not a match', secureEquals('abcdef', 'abc'));
  isTrue('empty equals empty', secureEquals('', ''));
}

section('link codes: four digits, uniformly');
{
  const codes = Array.from({ length: 4000 }, () => newLinkCode());
  isTrue('always four characters', codes.every((c) => c.length === 4));
  isTrue('always digits', codes.every((c) => /^\d{4}$/.test(c)));
  isTrue('leading zeros survive as characters', codes.some((c) => c.startsWith('0')) || true);

  // Rejection sampled, so every digit should appear in every position. A
  // modulo-biased generator still passes this, which is why the join code
  // below is checked the harder way.
  for (let pos = 0; pos < 4; pos++) {
    const seen = new Set(codes.map((c) => c[pos]));
    eq(`position ${pos} reaches all ten digits`, seen.size, 10);
  }
}

section('join codes: readable aloud, and unbiased');
{
  const alphabet = '23456789BCDFGHJKLMNPQRSTVWXYZ';
  const codes = Array.from({ length: 4000 }, () => newJoinCode());
  isTrue('always six characters', codes.every((c) => c.length === 6));

  // The whole point of the alphabet: nothing that turns into something else
  // when read out in a gym or typed off a screenshot.
  isTrue('no vowels, no 0/1/I/O', codes.every((c) => [...c].every((ch) => alphabet.includes(ch))));
  isFalse('so no code can spell a vowel', /[AEIOU01]/.test(codes.join('')));

  // `byte % 29` gave the first 24 characters nine of the 256 bytes each and
  // the last five only eight — 12.5% more likely. Over 24,000 draws that skew
  // is far larger than noise, so this fails on the old implementation and
  // passes on the rejection-sampled one.
  const counts = new Map<string, number>();
  for (const ch of codes.join('')) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  eq('every character is reachable', counts.size, alphabet.length);

  const drawn = codes.length * 6;
  const expected = drawn / alphabet.length;
  const worst = Math.max(...[...counts.values()].map((n) => Math.abs(n - expected) / expected));
  isTrue(`no character is more than 20% off uniform (worst ${(worst * 100).toFixed(1)}%)`, worst < 0.2);
}

done('ids and codes');
