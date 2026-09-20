/**
 * Scrubs credentials out of text before it is traced or logged.
 *
 * Solana RPC client errors routinely embed the request URL, and the working
 * devnet URL carries its API key in the query string. Without this, one failed
 * call writes the key into the trace feed — served by GET /trace to anyone
 * with a bearer token — and into the Worker logs.
 *
 * Written before a keyed URL exists, because the first time it matters is the
 * first time something fails, and that is not a moment to be discovering this.
 */

/** Query parameters whose values are secrets wherever they appear. */
const SECRET_PARAMS = ['api-key', 'apikey', 'api_key', 'key', 'token', 'access_token'];

const PARAM_PATTERN = new RegExp(`([?&](?:${SECRET_PARAMS.join('|')})=)[^&\\s"'\`)\\]}]+`, 'gi');

/** `Authorization: Bearer <token>` and bare `whsec_`/`sk-` style values. */
const BEARER_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const PREFIXED_SECRET_PATTERN = /\b((?:whsec_|sk-|linq_|cfut_)[A-Za-z0-9._~+/=-]{6,})/gi;

export function redact(text: string): string {
  return text
    .replace(PARAM_PATTERN, '$1[redacted]')
    .replace(BEARER_PATTERN, '$1[redacted]')
    .replace(PREFIXED_SECRET_PATTERN, (match) => `${match.slice(0, match.indexOf('_') + 1 || 3)}[redacted]`);
}
