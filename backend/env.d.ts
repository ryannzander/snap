/**
 * The secrets, declared rather than generated.
 *
 * `wrangler types` writes `worker-configuration.d.ts` from wrangler.toml plus
 * whatever happens to be in `.dev.vars` — and `.dev.vars` is gitignored,
 * because it holds real keys. So on a fresh clone the generated `Env` has the
 * [vars] and none of the secrets, and `npm test` fails with twenty
 * "Property 'DEBUG_KEY' does not exist on type 'Env'" errors that have nothing
 * to do with the code. Every new contributor, and every CI run, hits it.
 *
 * TypeScript merges interfaces of the same name across files, so declaring
 * them here adds them to the generated `Env` when `.dev.vars` is absent and
 * agrees with it when it is present. The names are not secret; only the values
 * are, and none of those are here.
 *
 * Everything here is optional, deliberately. That is the truth at runtime —
 * `wrangler secret put` is a deploy-time step and any of these can be unset —
 * and the code already reads them that way: no brain without OPENAI_API_KEY,
 * no delivery without LINQ_API_KEY, `/debug/*` answering 404 without DEBUG_KEY.
 */
interface Env {
  /** Linq Partner API bearer token. Without it, sends fall back to the trace channel. */
  LINQ_API_KEY?: string;
  /** Standard Webhooks signing secret. Unset skips signature verification. */
  LINQ_SIGNING_SECRET?: string;
  /** Unset falls back to the Workers AI binding. */
  OPENAI_API_KEY?: string;
  /** Guards /debug/*. Unset makes those routes 404 rather than 401. */
  DEBUG_KEY?: string;
  /** Devnet wallet seeds, 32 bytes base64. Unset means no money moves. */
  SNAP_TREASURY_SEED?: string;
  SNAP_ESCROW_SEED?: string;
  /** Devnet RPC with an API key. Secret-only: the key rides in the query string. */
  SOLANA_RPC_URL?: string;
}
