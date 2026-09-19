/**
 * Standard Webhooks signature verification on the Linq inbound path.
 *
 * This is the only unauthenticated route on the Worker, so it is the only one
 * a stranger can reach. It is also the route that, when it started rejecting
 * unsigned requests, made a whole demo rehearsal silently do nothing while
 * appearing to pass — worth having covered.
 */
import crypto from 'node:crypto';
import { verifySignature } from '../src/channels/linq';
import { section, eq, done } from './harness';

const SECRET_RAW = crypto.randomBytes(32);
const SECRET = 'whsec_' + SECRET_RAW.toString('base64');
const NOW = 1_789_000_000_000;

const sign = (id: string, ts: string, body: string, key: Buffer): string =>
  crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');

const body = JSON.stringify({ event_type: 'message.received', data: {} });
const id = 'msg_abc123';
const ts = String(Math.floor(NOW / 1000));
const good = sign(id, ts, body, SECRET_RAW);

const headers = (over: Record<string, string> = {}) =>
  new Headers({ 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${good}`, ...over });

async function check(label: string, promise: Promise<boolean>, want: boolean): Promise<void> {
  eq(label, await promise, want);
}

section('a correctly signed delivery');
await check('is accepted', verifySignature(headers(), body, SECRET, NOW), true);

section('everything that should be refused');
await check('a tampered body', verifySignature(headers(), body + ' ', SECRET, NOW), false);
await check(
  'the wrong secret',
  verifySignature(headers(), body, 'whsec_' + crypto.randomBytes(32).toString('base64'), NOW),
  false,
);
await check('a swapped webhook-id', verifySignature(headers({ 'webhook-id': 'other' }), body, SECRET, NOW), false);
await check('no headers at all', verifySignature(new Headers(), body, SECRET, NOW), false);
await check(
  'a garbage signature',
  verifySignature(headers({ 'webhook-signature': 'v1,notbase64!!' }), body, SECRET, NOW),
  false,
);
await check('an empty signature', verifySignature(headers({ 'webhook-signature': '' }), body, SECRET, NOW), false);
await check(
  'a non-numeric timestamp',
  verifySignature(headers({ 'webhook-timestamp': 'abc' }), body, SECRET, NOW),
  false,
);

section('the five-minute replay window');
await check('299 seconds old is still fresh', verifySignature(headers(), body, SECRET, NOW + 299_000), true);
await check('301 seconds old is a replay', verifySignature(headers(), body, SECRET, NOW + 301_000), false);
await check('301 seconds in the future', verifySignature(headers(), body, SECRET, NOW - 301_000), false);

section('secret rotation — several signatures, space separated');
{
  const other = sign(id, ts, body, crypto.randomBytes(32));
  await check(
    'accepted when one of them is ours',
    verifySignature(headers({ 'webhook-signature': `v1,${other} v1,${good}` }), body, SECRET, NOW),
    true,
  );
  await check(
    'refused when none of them are',
    verifySignature(
      headers({ 'webhook-signature': `v1,${other} v1,${sign(id, ts, body, crypto.randomBytes(32))}` }),
      body,
      SECRET,
      NOW,
    ),
    false,
  );
}

done('webhook signatures');
