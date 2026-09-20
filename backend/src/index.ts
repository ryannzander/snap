/**
 * Snap backend — Cloudflare Worker.
 *
 * The Worker is a thin edge: it authenticates, parses, and hands off to the
 * caller's UserAgent Durable Object, which owns all the state.
 *
 * Routes are exactly the ones in docs/API.md. Everything except /onboard and
 * /webhooks/* needs `Authorization: Bearer <token>`.
 */

import type { ChannelName, InboundMessage } from './channel';
import { normalizeInbound, verifySignature } from './channels/linq';
import { competitionStub } from './competitions/competition';
import { MAX_ENTRY_LAMPORTS, MIN_ENTRY_LAMPORTS } from './competitions/rules';
import { directoryStub } from './directory';
import { USER_FUNDING_LAMPORTS } from './money';
import { redact } from './redact';
import { getBalanceLamports, rpcFor, walletFromSeed } from './solana/wallet';
import { HttpError, errorResponse, json, toResponse } from './http';
import { newUserId, userIdFromToken } from './ids';
import type { OnboardResponse } from './types';
import type { UserAgent } from './user-agent';
import {
  parseCompetitionRequest,
  parseOnboardRequest,
  parseSince,
  parseTopUpRequest,
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

    case '/wallet':
      requireMethod(request, 'GET');
      return getWallet(request, env);

    case '/wallet/topup':
      requireMethod(request, 'POST');
      return topUpWallet(request, env);

    case '/trace':
      requireMethod(request, 'GET');
      return getTrace(request, url, env);

    case '/debug/timewarp':
      requireMethod(request, 'POST');
      return timewarp(request, env);

    case '/debug/seed':
      requireMethod(request, 'POST');
      return seed(request, env);

    case '/debug/forget':
      requireMethod(request, 'POST');
      return forget(request, env);

    case '/debug/demo':
      requireMethod(request, 'POST');
      return demoSettings(request, env);

    case '/debug/chain':
      requireMethod(request, 'GET');
      return chainState(request, env);

    case '/debug/inbound':
      requireMethod(request, 'POST');
      return debugInbound(request, env, ctx);

    case '/debug/reclaim':
      requireMethod(request, 'POST');
      return reclaimWallet(request, env);

    case '/debug/airdrop':
      requireMethod(request, 'POST');
      return airdropTreasury(request, env);

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

/** The money, where it is, and how it got there. See docs/API.md → GET /wallet. */
async function getWallet(request: Request, env: Env): Promise<Response> {
  const { token, stub } = authenticate(request, env);
  return toResponse(await stub.getWallet(token));
}

/**
 * Adds money. On devnet the treasury is the funding source, so this is the
 * "add money" button doing exactly what it says without a card in the loop.
 */
async function topUpWallet(request: Request, env: Env): Promise<Response> {
  const { token, stub } = authenticate(request, env);
  const lamports = parseTopUpRequest(await readJsonBody(request));
  return toResponse(await stub.topUpWallet(token, lamports));
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

  // Unsigned deliveries are refused, and a MISSING secret refuses them too.
  //
  // This used to fail open: with no `LINQ_SIGNING_SECRET` configured the
  // check was skipped entirely, so anyone who found the URL could post as
  // anyone's chat — make a commitment, accept an offer, move money. A
  // forgotten `wrangler secret put` turned the whole webhook into an open
  // door, and nothing anywhere would have said so.
  //
  // `SNAP_CHANNEL = "trace"` is the one exception, because it already means
  // exactly "this is a local run": wrangler.local.toml sets it, it is what
  // stops outbound sends reaching a real phone, and production is "linq". One
  // flag, one meaning, and no new knob that can be left on by accident.
  const localRun = (env.SNAP_CHANNEL as string) === 'trace';
  if (!env.LINQ_SIGNING_SECRET) {
    if (!localRun) {
      console.error('refusing webhook: LINQ_SIGNING_SECRET is not set');
      return errorResponse(401, 'bad_signature', 'webhook signature did not verify');
    }
  } else {
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

  // A tapback arrives on its own — it has no text and no photo. A delivery
  // that carries both is a message that happens to mention a reaction, and the
  // words are the part worth answering.
  if (inbound.reaction && inbound.text === '' && inbound.imageUrls.length === 0) {
    return deliverReaction(env, ctx, inbound);
  }

  return deliver(
    env,
    ctx,
    inbound.channel,
    inbound.chatId,
    inbound.text,
    inbound.imageUrls,
    inbound.messageId,
  );
}

/**
 * A tapback on one of Snap's texts.
 *
 * Routed apart from messages because it is not one: there is no link code to
 * read out of it, an unlinked chat has nothing to react to, and the reply —
 * when there is one at all — is a different kind of turn.
 */
async function deliverReaction(
  env: Env,
  ctx: ExecutionContext,
  inbound: InboundMessage,
): Promise<Response> {
  const reaction = inbound.reaction;
  if (!reaction) return json({ ok: true, ignored: 'not a reaction' });

  const userId = await directoryStub(env).lookupChat(inbound.channel, inbound.chatId);
  if (!userId) return json({ ok: true, ignored: 'chat not linked' });

  const stub = userStub(env, userId);
  const received = await stub.receiveReaction(
    reaction.emoji,
    reaction.name,
    reaction.targetMessageId,
    reaction.removed,
  );
  if (!received.ok) return json({ ok: true, ignored: 'no such user' });

  // Accepting an offer already says everything: the acceptance path sends its
  // own confirmation, and a second turn on top would talk over it.
  if (!received.value.optedOut && !received.value.accepted && !reaction.removed) {
    ctx.waitUntil(
      stub.runReactionTurn(
        reaction.emoji,
        reaction.name,
        reaction.targetMessageId,
      ) as unknown as Promise<unknown>,
    );
  }
  return json({ ok: true, reaction: reaction.emoji, accepted: received.value.accepted });
}

/** `yo <code>` links a chat to a user; anything else goes to the linked user. */
async function deliver(
  env: Env,
  ctx: ExecutionContext,
  channel: ChannelName,
  chatId: string,
  text: string,
  imageUrls: string[] = [],
  messageId: string | null = null,
): Promise<Response> {
  const code = /^\s*yo[\s,]+(\d{4})\s*[.!]?\s*$/i.exec(text)?.[1];

  if (code) {
    const directory = directoryStub(env);

    // Guessing costs attempts. Four digits is ten thousand tries and a hit
    // hands over somebody's whole thread, so a chat gets a handful and then
    // stops being listened to. Spent BEFORE the lookup, or the counter only
    // ever moves on codes that were already wrong for another reason.
    if (!(await directory.spendLinkAttempt(channel, chatId))) {
      return json({ ok: true, ignored: 'too many link attempts' });
    }

    const userId = await directory.lookupLinkCode(code);
    // An unknown code gets no reply: answering would burn a message from the
    // sandbox budget and tell a stranger whether a code exists.
    if (!userId) return json({ ok: true, ignored: 'unknown link code' });

    await directory.bindChat(channel, chatId, userId);
    const result = await userStub(env, userId).linkChat(channel, chatId);
    if (!result.ok) return json({ ok: true, ignored: 'no such user' });

    // Spent only now, once something is actually linked — a bind that failed
    // halfway would otherwise leave the code dead and the person with no way
    // in. A linked chat gets its attempt count back, too.
    await directory.consumeLinkCode(code, userId);
    await directory.clearLinkAttempts(channel, chatId);
    return json({ ok: true, linked: true });
  }

  const userId = await directoryStub(env).lookupChat(channel, chatId);
  if (!userId) return json({ ok: true, ignored: 'chat not linked' });

  const stub = userStub(env, userId);
  const received = await stub.receiveMessage(text, imageUrls, messageId);

  // The model, then a paced burst of texts, is far longer than a webhook
  // should be held open — and Linq retries anything slow. Acknowledge now and
  // let the turn finish in the background. A photo adds a look at the image
  // before the turn; that happens in the background too.
  if (received.ok && !received.value.optedOut) {
    ctx.waitUntil(stub.runInboundTurn(text, imageUrls) as unknown as Promise<unknown>);
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
 * Where the money actually is, on the day.
 *
 * The treasury funds every new wallet and the escrow holds every live stake,
 * and until this existed neither balance was visible anywhere: the only way
 * to learn the treasury had run dry was to onboard somebody and notice their
 * wallet was empty. Which is how it was found — mid-rehearsal, with
 * *"Transfer: insufficient lamports 129570000, need 210000000"* buried in a
 * worker log, hours before a demo where onboarding happens on stage.
 *
 * Addresses are public by nature; the seeds that derive them never leave the
 * secret store. Behind the debug key like the rest, and `runway` is the
 * number worth reading — how many more people can onboard before funding
 * starts failing.
 */
async function chainState(request: Request, env: Env): Promise<Response> {
  if (!env.DEBUG_KEY) {
    return errorResponse(404, 'not_found', 'no route for GET /debug/chain');
  }
  if (!timingSafeEqual(request.headers.get('x-debug-key') ?? '', env.DEBUG_KEY)) {
    return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
  }
  if (!env.SOLANA_RPC_URL) {
    return errorResponse(503, 'chain_unavailable', 'no SOLANA_RPC_URL configured');
  }

  const rpc = rpcFor(env.SOLANA_RPC_URL);
  const look = async (seed: string | undefined) => {
    if (!seed) return { address: null, lamports: null };
    const wallet = await walletFromSeed(seed);
    try {
      return { address: String(wallet.address), lamports: await getBalanceLamports(rpc, wallet.address) };
    } catch {
      return { address: String(wallet.address), lamports: null };
    }
  };

  const [treasury, escrow] = await Promise.all([
    look(env.SNAP_TREASURY_SEED),
    look(env.SNAP_ESCROW_SEED),
  ]);

  return json({
    cluster: 'devnet',
    treasury,
    escrow,
    perUserFundingLamports: USER_FUNDING_LAMPORTS,
    runway:
      treasury.lamports === null ? null : Math.floor(treasury.lamports / USER_FUNDING_LAMPORTS),
  });
}

/**
 * Delivers a text down the REAL inbound path, without a signature.
 *
 * `/debug/message` takes a user's token and skips straight to the agent, which
 * means the code in front of it — link codes, chat routing, opt-out — was
 * reachable only through a signed Linq webhook. So the one step the whole demo
 * depends on, `yo <code>`, could not be tested by anything but a real phone,
 * and changing it was a change nobody could check.
 *
 * Same door as the vendor's, minus the vendor. Debug key only, since there is
 * no user yet to hold a token — which is the point of it.
 */
async function debugInbound(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.DEBUG_KEY) {
    return errorResponse(404, 'not_found', 'no route for POST /debug/inbound');
  }
  if (!timingSafeEqual(request.headers.get('x-debug-key') ?? '', env.DEBUG_KEY)) {
    return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
  }

  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const chatId = typeof record.chatId === 'string' ? record.chatId.trim() : '';
  const text = typeof record.text === 'string' ? record.text : '';
  if (!chatId) throw new HttpError(400, 'bad_request', 'chatId is required');

  const channel: ChannelName = record.channel === 'trace' ? 'trace' : 'linq';
  return deliver(env, ctx, channel, chatId, text);
}

/**
 * Hands a rehearsal's wallet back to the treasury. Debug key plus the user's
 * own token, like the rest — see `UserAgent.reclaim`.
 */
async function reclaimWallet(request: Request, env: Env): Promise<Response> {
  if (!env.DEBUG_KEY) {
    return errorResponse(404, 'not_found', 'no route for POST /debug/reclaim');
  }
  if (!timingSafeEqual(request.headers.get('x-debug-key') ?? '', env.DEBUG_KEY)) {
    return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
  }
  const { token, stub } = authenticate(request, env);
  return toResponse(await stub.reclaim(token));
}

/**
 * Asks devnet for more test SOL, from inside the Worker.
 *
 * The treasury funds every new wallet, and when it runs dry onboarding
 * silently produces people with empty pockets. Refilling it needs the keyed
 * RPC, which lives in the secret store and never leaves it — so the request
 * has to be made from in here rather than from somebody's laptop. The public
 * faucet rate-limits by IP and is frequently dry; the configured provider
 * usually is not.
 *
 * It only ever pulls free devnet SOL IN, to one address derived from a seed
 * this code already holds. It cannot move a user's money, and there is no
 * amount of it that is worth anything.
 */
async function airdropTreasury(request: Request, env: Env): Promise<Response> {
  if (!env.DEBUG_KEY) {
    return errorResponse(404, 'not_found', 'no route for POST /debug/airdrop');
  }
  if (!timingSafeEqual(request.headers.get('x-debug-key') ?? '', env.DEBUG_KEY)) {
    return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
  }
  if (!env.SOLANA_RPC_URL || !env.SNAP_TREASURY_SEED) {
    return errorResponse(503, 'chain_unavailable', 'no RPC or treasury configured');
  }

  const body = await readJsonBody(request).catch(() => ({}));
  const asked = (body as Record<string, unknown>)?.sol;
  const sol = typeof asked === 'number' && asked > 0 && asked <= 5 ? asked : 1;

  const treasury = await walletFromSeed(env.SNAP_TREASURY_SEED);
  const response = await fetch(env.SOLANA_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'requestAirdrop',
      params: [String(treasury.address), Math.round(sol * 1_000_000_000)],
    }),
  });
  const text = await response.text();
  const rpc = rpcFor(env.SOLANA_RPC_URL);
  let lamports: number | null = null;
  try {
    lamports = await getBalanceLamports(rpc, treasury.address);
  } catch {
    lamports = null;
  }

  return json({
    address: String(treasury.address),
    asked: sol,
    // Redacted: the RPC url carries its key and an error body can echo it.
    result: redact(text).slice(0, 400),
    lamports,
    runway: lamports === null ? null : Math.floor(lamports / USER_FUNDING_LAMPORTS),
  });
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

  const record = body as Record<string, unknown>;
  const imageUrl = record.imageUrl;
  if (imageUrl !== undefined && (typeof imageUrl !== 'string' || !/^https?:\/\//i.test(imageUrl))) {
    throw new HttpError(400, 'bad_request', 'imageUrl must be an http(s) URL');
  }
  const imageUrls = typeof imageUrl === 'string' ? [imageUrl] : [];

  const text = record.text ?? '';
  if (typeof text !== 'string' || (text.trim() === '' && imageUrls.length === 0)) {
    throw new HttpError(400, 'bad_request', 'text must be a non-empty string, or send an imageUrl');
  }
  if (text.length > MAX_INBOUND_TEXT) {
    throw new HttpError(400, 'bad_request', `text must be at most ${MAX_INBOUND_TEXT} characters`);
  }

  return toResponse(await stub.receiveDebugMessage(token, text.trim(), imageUrls));
}

/**
 * The stage valve, per user. Demo only, same guard as the rest of /debug.
 *
 * `{}` reads the current settings; anything set writes. It exists because the
 * closing beat depends on a vision model judging a photo live, and the most
 * likely failure is that model hedging at a perfectly good picture — see
 * DemoSettings in user-agent.ts.
 */
async function demoSettings(request: Request, env: Env): Promise<Response> {
  if (!env.DEBUG_KEY) {
    return errorResponse(404, 'not_found', 'no route for POST /debug/demo');
  }
  if (!timingSafeEqual(request.headers.get('x-debug-key') ?? '', env.DEBUG_KEY)) {
    return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
  }

  const { token, stub } = authenticate(request, env);
  const body = await readJsonBody(request);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new HttpError(400, 'bad_request', 'body must be a JSON object');
  }
  const record = body as Record<string, unknown>;

  const update: { photoMode?: 'strict' | 'lenient' | 'always'; allowReplay?: boolean } = {};
  if (record.photoMode !== undefined) {
    if (record.photoMode !== 'strict' && record.photoMode !== 'lenient' && record.photoMode !== 'always') {
      throw new HttpError(400, 'bad_request', 'photoMode must be strict, lenient or always');
    }
    update.photoMode = record.photoMode;
  }
  if (record.allowReplay !== undefined) {
    if (typeof record.allowReplay !== 'boolean') {
      throw new HttpError(400, 'bad_request', 'allowReplay must be a boolean');
    }
    update.allowReplay = record.allowReplay;
  }

  // An empty body reads rather than writes, so the app can show the switch's
  // real position instead of guessing it.
  const wrote = Object.keys(update).length > 0;
  return toResponse(await stub.demoSettings(token, wrote ? update : undefined));
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

/**
 * The server half of "reset app". Without it the phone forgets the user and
 * the agent does not: its alarms keep firing into a thread the phone has walked
 * away from, texting about a commitment from before the reset.
 */
async function forget(request: Request, env: Env): Promise<Response> {
  if (!env.DEBUG_KEY) {
    return errorResponse(404, 'not_found', 'no route for POST /debug/forget');
  }
  if (!timingSafeEqual(request.headers.get('x-debug-key') ?? '', env.DEBUG_KEY)) {
    return errorResponse(401, 'unauthorized', 'bad X-Debug-Key');
  }
  const { token, stub, userId } = authenticate(request, env);
  const result = await stub.forget(token);

  // Unbinding is the directory's to do, and only on the way out of a successful
  // forget — a 401 here means the token was not this user's to stand down.
  if (result.ok) {
    const directory = directoryStub(env);
    const { channel, chatId, linkCode } = result.value;
    if (channel && chatId) await directory.releaseChat(channel, chatId, userId);
    if (linkCode) await directory.releaseLinkCode(linkCode, userId);
  }
  return toResponse(result);
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
