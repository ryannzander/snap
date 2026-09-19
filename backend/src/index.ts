/**
 * Snap backend — Cloudflare Worker.
 *
 * The Worker is a thin edge: it authenticates, parses, and hands off to the
 * caller's UserAgent Durable Object, which owns all the state.
 *
 * Routes are exactly the ones in docs/API.md. Everything except /onboard and
 * /webhooks/* needs `Authorization: Bearer <token>`.
 */

import type { ChannelName } from './channel';
import { normalizeInbound, verifySignature } from './channels/linq';
import { competitionStub } from './competitions/competition';
import { MAX_ENTRY_LAMPORTS, MIN_ENTRY_LAMPORTS } from './competitions/rules';
import { directoryStub } from './directory';
import { HttpError, errorResponse, json, toResponse } from './http';
import { newUserId, userIdFromToken } from './ids';
import type { OnboardResponse } from './types';
import type { UserAgent } from './user-agent';
import {
  parseCompetitionRequest,
  parseOnboardRequest,
  parseSince,
  parseWorkoutsRequest,
  readJsonBody,
} from './validate';

export { Competition } from './competitions/competition';
export { Directory } from './directory';
export { UserAgent } from './user-agent';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) return error.toResponse();
      console.error('unhandled error', error);
      return errorResponse(500, 'internal_error', 'something went wrong on our side');
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  switch (path) {
    case '/onboard':
      requireMethod(request, 'POST');
      return onboard(request, env);

    case '/workouts':
      requireMethod(request, 'POST');
      return postWorkouts(request, env);

    case '/state':
      requireMethod(request, 'GET');
      return getState(request, env);

    case '/trace':
      requireMethod(request, 'GET');
      return getTrace(request, url, env);

    case '/debug/timewarp':
      requireMethod(request, 'POST');
      return timewarp(request, env);

    case '/debug/seed':
      requireMethod(request, 'POST');
      return seed(request, env);

    case '/debug/message':
      requireMethod(request, 'POST');
      return debugMessage(request, env);

    case '/webhooks/linq':
      requireMethod(request, 'POST');
      return linqWebhook(request, env, ctx);

    case '/competitions':
      if (request.method === 'GET') return listCompetitions(request, env);
      requireMethod(request, 'POST');
      return createCompetition(request, env);

    case '/competitions/join':
      requireMethod(request, 'POST');
      return joinCompetition(request, env);

    default:
      // /competitions/<id> and /competitions/<id>/settle
      if (path.startsWith('/competitions/')) return competitionById(request, env, path);

      return errorResponse(404, 'not_found', `no route for ${request.method} ${path}`);
  }
}

// --- competitions ----------------------------------------------------------

/**
 * ROADMAP.md → "Competitions": a pot, a rule, a set of entrants and an oracle.
 * The creator is the first entrant, so making one stakes you into it — an
 * empty competition nobody has joined is not a thing worth having.
 */
async function createCompetition(request: Request, env: Env): Promise<Response> {
  const { token, stub, userId } = authenticate(request, env);
  const input = parseCompetitionRequest(await readJsonBody(request));

  const entryLamports =
    input.sol === undefined ? DEFAULT_ENTRY_LAMPORTS : Math.round(input.sol * 1_000_000_000);
  if (entryLamports < MIN_ENTRY_LAMPORTS) {
    throw new HttpError(400, 'bad_request', 'that entry is too small to be worth locking');
  }
  if (entryLamports > MAX_ENTRY_LAMPORTS) {
    throw new HttpError(400, 'bad_request', 'entry is above the 1 SOL ceiling');
  }

  // The token has to be good before anything is reserved or any money moves.
  const state = await stub.getState(token);
  if (!state.ok) return toResponse(state);

  const id = `comp_${crypto.randomUUID().slice(0, 8)}`;
  const joinCode = await directoryStub(env).claimJoinCode(id);
  const now = Date.now();

  const created = await competitionStub(env, id).create({
    id,
    kind: input.kind,
    name: input.name,
    goal: input.goal,
    entryLamports,
    joinCode,
    startsAt: new Date(now).toISOString(),
    endsAt: new Date(now + input.days * 86_400_000).toISOString(),
    createdBy: userId,
  });
  if (!created.ok) return toResponse(created);

  return toResponse(await competitionStub(env, id).join(userId));
}

/** `{ "joinCode": "K7MBQ2" }` — stakes you in and puts you on the board. */
async function joinCompetition(request: Request, env: Env): Promise<Response> {
  const { token, stub, userId } = authenticate(request, env);
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'body must be a JSON object');
  }
  const code = (body as Record<string, unknown>).joinCode;
  if (typeof code !== 'string' || !code.trim()) {
    throw new HttpError(400, 'bad_request', 'joinCode is required');
  }

  const state = await stub.getState(token);
  if (!state.ok) return toResponse(state);

  const id = await directoryStub(env).lookupJoinCode(code);
  if (!id) return errorResponse(404, 'not_found', 'no competition with that code');

  return toResponse(await competitionStub(env, id).join(userId));
}

/** Every competition this user is in, each with live standings. */
async function listCompetitions(request: Request, env: Env): Promise<Response> {
  const { token, stub } = authenticate(request, env);
  const mine = await stub.listCompetitions(token);
  if (!mine.ok) return toResponse(mine);

  const entries = mine.value.competitions;
  const views = await Promise.all(
    entries.map(async (entry) => {
      const view = await competitionStub(env, entry.id).view();
      return view.ok ? view.value : null;
    }),
  );
  return json({ competitions: views.filter((view) => view !== null) });
}

/** GET /competitions/<id>, and POST /competitions/<id>/settle. */
async function competitionById(request: Request, env: Env, path: string): Promise<Response> {
  const rest = path.slice('/competitions/'.length);
  const [id, action] = rest.split('/');
  if (!id) return errorResponse(404, 'not_found', `no route for ${request.method} ${path}`);

  const { token, stub } = authenticate(request, env);
  const state = await stub.getState(token);
  if (!state.ok) return toResponse(state);

  if (action === 'settle') {
    requireMethod(request, 'POST');
    // Settling early moves real money, so it carries the debug gate as well as
    // the bearer token — on the day it is a button, not something a user does.
    if (!env.DEBUG_KEY) return errorResponse(404, 'not_found', `no route for POST ${path}`);
    if (!timingSafeEqual(request.headers.get('x-debug-key') ?? '', env.DEBUG_KEY)) {
      return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
    }
    return toResponse(await competitionStub(env, id).settle());
  }

  if (action !== undefined) return errorResponse(404, 'not_found', `no route for ${request.method} ${path}`);
  requireMethod(request, 'GET');
  return toResponse(await competitionStub(env, id).view());
}

// --- handlers --------------------------------------------------------------

/** Longest inbound text /debug/message will accept — an SMS, not an essay. */
const MAX_INBOUND_TEXT = 1000;

/** DESIGN.md's default stake, reused as the default competition entry. */
const DEFAULT_ENTRY_LAMPORTS = 50_000_000;

async function onboard(request: Request, env: Env): Promise<Response> {
  const input = parseOnboardRequest(await readJsonBody(request));

  const userId = newUserId();
  const linkCode = await directoryStub(env).claimLinkCode(userId);

  const result = await userStub(env, userId).initialize({ ...input, userId, linkCode });
  if (!result.ok) return toResponse(result);

  const response: OnboardResponse = {
    userId,
    token: result.value.token,
    linkCode,
    snapContact: {
      telegram: env.SNAP_TELEGRAM,
      imessage: env.SNAP_IMESSAGE,
    },
  };
  return json(response);
}

async function postWorkouts(request: Request, env: Env): Promise<Response> {
  const { token, stub } = authenticate(request, env);
  const workouts = parseWorkoutsRequest(await readJsonBody(request));
  return toResponse(await stub.ingestWorkouts(token, workouts));
}

async function getState(request: Request, env: Env): Promise<Response> {
  const { token, stub } = authenticate(request, env);
  return toResponse(await stub.getState(token));
}

async function getTrace(request: Request, url: URL, env: Env): Promise<Response> {
  const { token, stub } = authenticate(request, env);
  const since = parseSince(url.searchParams.get('since'));
  return toResponse(await stub.getTrace(token, since));
}

/**
 * Inbound from Linq. Unauthenticated by design — the signature is the auth —
 * so it verifies, de-duplicates, and then answers 200 for everything.
 *
 * A non-200 makes Linq retry, and a retry of a message we could not route is
 * no more routable the second time, so unknown events and unlinked chats are
 * acknowledged rather than rejected.
 */
async function linqWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await request.text();

  if (env.LINQ_SIGNING_SECRET) {
    const valid = await verifySignature(
      request.headers,
      rawBody,
      env.LINQ_SIGNING_SECRET,
      Date.now(),
    );
    if (!valid) return errorResponse(401, 'bad_signature', 'webhook signature did not verify');
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json({ ok: true, ignored: 'unparseable' });
  }

  const inbound = normalizeInbound(body);
  if (!inbound) return json({ ok: true, ignored: 'not an inbound text' });

  const directory = directoryStub(env);
  if (!(await directory.claimEvent(inbound.eventId))) {
    return json({ ok: true, ignored: 'duplicate delivery' });
  }

  return deliver(env, ctx, inbound.channel, inbound.chatId, inbound.text);
}

/** `yo <code>` links a chat to a user; anything else goes to the linked user. */
async function deliver(
  env: Env,
  ctx: ExecutionContext,
  channel: ChannelName,
  chatId: string,
  text: string,
): Promise<Response> {
  const code = /^\s*yo[\s,]+(\d{4})\s*[.!]?\s*$/i.exec(text)?.[1];

  if (code) {
    const userId = await directoryStub(env).lookupLinkCode(code);
    // An unknown code gets no reply: answering would burn a message from the
    // sandbox budget and tell a stranger whether a code exists.
    if (!userId) return json({ ok: true, ignored: 'unknown link code' });

    await directoryStub(env).bindChat(channel, chatId, userId);
    const result = await userStub(env, userId).linkChat(channel, chatId);
    return result.ok ? json({ ok: true, linked: true }) : json({ ok: true, ignored: 'no such user' });
  }

  const userId = await directoryStub(env).lookupChat(channel, chatId);
  if (!userId) return json({ ok: true, ignored: 'chat not linked' });

  const stub = userStub(env, userId);
  const received = await stub.receiveMessage(text);

  // The model, then a paced burst of texts, is far longer than a webhook
  // should be held open — and Linq retries anything slow. Acknowledge now and
  // let the turn finish in the background.
  if (received.ok && !received.value.optedOut) {
    ctx.waitUntil(
      stub.runAgent(`the user just texted you: "${text}". decide what to do.`, true) as unknown as Promise<unknown>,
    );
  }
  return json({ ok: true, received: true });
}

/**
 * Demo only. Needs the bearer token (whose user's clock this is) and the
 * X-Debug-Key header. With no DEBUG_KEY configured the route does not exist,
 * rather than advertising itself with a 401.
 */
async function timewarp(request: Request, env: Env): Promise<Response> {
  if (!env.DEBUG_KEY) {
    return errorResponse(404, 'not_found', 'no route for POST /debug/timewarp');
  }
  const supplied = request.headers.get('x-debug-key') ?? '';
  if (!timingSafeEqual(supplied, env.DEBUG_KEY)) {
    return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
  }

  const { token, stub } = authenticate(request, env);
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'body must be a JSON object');
  }

  const now = (body as Record<string, unknown>).now;
  if (now !== null && typeof now !== 'string') {
    throw new HttpError(400, 'bad_request', 'now must be an ISO 8601 string or null');
  }

  return toResponse(await stub.timewarp(token, now));
}

/**
 * Demo only. Delivers a message to the agent as though it had arrived as a
 * text, without the channel vendor in the path.
 *
 * Until this existed a real Linq webhook was the only way to reach the agent,
 * which made a sandbox API a single point of failure for the demo and put
 * agent reliability out of reach of measurement — every trial cost real
 * messages out of a 100/day budget.
 *
 * Same guard as the other debug routes: bearer token plus X-Debug-Key. It is
 * not a way in, it is a way to skip the vendor: the caller must already hold
 * the user's token.
 */
async function debugMessage(request: Request, env: Env): Promise<Response> {
  if (!env.DEBUG_KEY) {
    return errorResponse(404, 'not_found', 'no route for POST /debug/message');
  }
  if (!timingSafeEqual(request.headers.get('x-debug-key') ?? '', env.DEBUG_KEY)) {
    return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
  }

  const { token, stub } = authenticate(request, env);
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'body must be a JSON object');
  }

  const text = (body as Record<string, unknown>).text;
  if (typeof text !== 'string' || text.trim() === '') {
    throw new HttpError(400, 'bad_request', 'text must be a non-empty string');
  }
  if (text.length > MAX_INBOUND_TEXT) {
    throw new HttpError(400, 'bad_request', `text must be at most ${MAX_INBOUND_TEXT} characters`);
  }

  return toResponse(await stub.receiveDebugMessage(token, text.trim()));
}

/** Demo only. Same guard as timewarp: bearer token plus X-Debug-Key. */
async function seed(request: Request, env: Env): Promise<Response> {
  if (!env.DEBUG_KEY) {
    return errorResponse(404, 'not_found', 'no route for POST /debug/seed');
  }
  if (!timingSafeEqual(request.headers.get('x-debug-key') ?? '', env.DEBUG_KEY)) {
    return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
  }
  const { token, stub } = authenticate(request, env);
  return toResponse(await stub.seed(token));
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i]! ^ right[i]!;
  return diff === 0;
}

// --- plumbing --------------------------------------------------------------

function requireMethod(request: Request, method: string): void {
  if (request.method !== method) {
    throw new HttpError(405, 'method_not_allowed', `use ${method} on this route`);
  }
}

function userStub(env: Env, userId: string): DurableObjectStub<UserAgent> {
  return env.USER_AGENT.get(env.USER_AGENT.idFromName(userId));
}

/**
 * The bearer token carries its own userId, so the Worker can route straight to
 * the right Durable Object; that object then verifies the rest of the token.
 * A malformed token is rejected with the same 401 as a wrong one.
 */
function authenticate(
  request: Request,
  env: Env,
): { token: string; userId: string; stub: DurableObjectStub<UserAgent> } {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  const userId = token ? userIdFromToken(token) : null;

  if (!token || !userId) {
    throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token');
  }
  return { token, userId, stub: userStub(env, userId) };
}
