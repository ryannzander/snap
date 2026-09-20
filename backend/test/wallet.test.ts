/**
 * Adding money.
 *
 * The amount arrives as SOL because that is what a person taps, and has to
 * leave as lamports because that is what the chain and every other line of
 * this backend use. 0.1 is not representable in binary, so the conversion
 * happens exactly once — here — and these are the cases that would otherwise
 * make a deposit land a lamport short of what the button said.
 */
import { parseTopUpRequest } from '../src/validate';
import { solText } from '../src/money';
import { section, eq, throws, done } from './harness';

section('what the button sends');
{
  eq('the smallest top-up', parseTopUpRequest({ sol: 0.01 }), 10_000_000);
  eq('the one everyone taps', parseTopUpRequest({ sol: 0.1 }), 100_000_000);
  eq('a quarter', parseTopUpRequest({ sol: 0.25 }), 250_000_000);
  eq('the ceiling on one go', parseTopUpRequest({ sol: 1 }), 1_000_000_000);
  // The round trip is what matters: whatever the app showed, the wallet
  // screen has to show the same number back afterwards.
  eq('what the app will say it added', solText(parseTopUpRequest({ sol: 0.1 })), '0.1 SOL');
  eq('and for an awkward one', solText(parseTopUpRequest({ sol: 0.07 })), '0.07 SOL');
}

section('what it refuses');
{
  throws('dust', () => parseTopUpRequest({ sol: 0.0001 }));
  throws('under the floor', () => parseTopUpRequest({ sol: 0.009 }));
  throws('over the ceiling', () => parseTopUpRequest({ sol: 1.5 }));
  throws('nothing', () => parseTopUpRequest({ sol: 0 }));
  throws('a negative amount', () => parseTopUpRequest({ sol: -0.1 }));
  throws('a string', () => parseTopUpRequest({ sol: '0.1' }));
  throws('NaN', () => parseTopUpRequest({ sol: Number.NaN }));
  throws('infinity', () => parseTopUpRequest({ sol: Number.POSITIVE_INFINITY }));
  throws('no amount at all', () => parseTopUpRequest({}));
  throws('not an object', () => parseTopUpRequest('0.1'));
  throws('null', () => parseTopUpRequest(null));
}

done('wallet top-ups');
