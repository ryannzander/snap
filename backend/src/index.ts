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
import { directoryStub } from './directory';
import { HttpError, errorResponse, json, toResponse } from './http';
import { newUserId, userIdFromToken } from './ids';
import type { OnboardResponse } from './types';
import type { UserAgent } from './user-agent';
import {
  parseOnboardRequest,
  parseSince,
  parseWorkoutsRequest,
  readJsonBody,
} from './validate';

export { Directory } from './directory';
export { UserAgent } from './user-agent';

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof HttpError) return error.toResponse();
      console.error('unhandled error', error);
      return errorResponse(500, 'internal_error', 'something went wrong on our side');
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
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

    case '/webhooks/linq':
      requireMethod(request, 'POST');
      return linqWebhook(request, env);

    default:
      return errorResponse(404, 'not_found', `no route for ${request.method} ${path}`);
  }
}

// --- handlers --------------------------------------------------------------

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
async function linqWebhook(request: Request, env: Env): Promise<Response> {
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

  return deliver(env, inbound.channel, inbound.chatId, inbound.text);
}

/** `yo <code>` links a chat to a user; anything else goes to the linked user. */
async function deliver(
  env: Env,
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

  await userStub(env, userId).receiveMessage(text);
  return json({ ok: true, received: true });
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
): { token: string; stub: DurableObjectStub<UserAgent> } {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1]?.trim();
  const userId = token ? userIdFromToken(token) : null;

  if (!token || !userId) {
    throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token');
  }
  return { token, stub: userStub(env, userId) };
}
