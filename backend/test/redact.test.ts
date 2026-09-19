/**
 * Credentials must not reach the trace feed or the Worker logs.
 *
 * GET /trace serves trace data to anyone holding a bearer token, and a failed
 * Solana call embeds the request URL — which carries the API key in its query
 * string. The cases below are the real shapes, not invented ones.
 */
import { redact } from '../src/redact';
import { section, eq, isTrue, isFalse, done } from './harness';

const hides = (label: string, input: string, secret: string) => {
  const out = redact(input);
  isFalse(`${label} — secret gone`, out.includes(secret));
};

section('the shapes that actually occur');
{
  hides(
    'a Helius RPC failure',
    'SolanaError: failed to fetch https://devnet.helius-rpc.com/?api-key=abc123-SECRET-def: 429',
    'abc123-SECRET-def',
  );
  hides(
    'a Linq bearer token in an error body',
    'HTTP 401 {"headers":{"authorization":"Bearer linq_naWQdobLYuu9TYB8"}}',
    'linq_naWQdobLYuu9TYB8',
  );
  hides('a webhook signing secret', 'verify failed with whsec_bHE1vhV2H3PLggM6QERoLrtjlpKhWjQ7I', 'bHE1vhV2H3PLggM6QERoLrtjlpKhWjQ7I');
  hides('an OpenAI key', 'openai said 401 for sk-proj-AAAABBBBCCCCDDDD', 'proj-AAAABBBBCCCCDDDD');
  hides('a Cloudflare token', 'deploy failed: cfut_9xQlWmZ0aaaa1111', '9xQlWmZ0aaaa1111');
  hides('an apikey= spelling', 'GET https://rpc.example.com/?apikey=SECRETVALUE1 -> 403', 'SECRETVALUE1');
  hides('an access_token= spelling', 'https://x.test/cb?access_token=SECRETVALUE2&state=1', 'SECRETVALUE2');
}

section('a redacted message still says which kind of credential it was');
{
  const out = redact('verify failed with whsec_bHE1vhV2H3PLggM6QERoLrtjlpKhWjQ7I');
  isTrue('the whsec_ prefix survives', out.includes('whsec_'));
  const url = redact('failed to fetch https://devnet.helius-rpc.com/?api-key=abc123: 429');
  isTrue('the host survives', url.includes('devnet.helius-rpc.com'));
  isTrue('the parameter name survives', url.includes('api-key='));
  isTrue('the status code survives', url.includes('429'));
}

section('ordinary errors pass through untouched');
{
  const plain = 'transaction failed: {"InstructionError":[0,{"Custom":1}]}';
  eq('a Solana instruction error', redact(plain), plain);
  const nothing = 'no brain configured';
  eq('an ordinary sentence', redact(nothing), nothing);
  // "key" as a word, not a parameter.
  const wordy = 'the key question is whether the alarm fired';
  eq('the word "key" in prose', redact(wordy), wordy);
}

done('redaction');
