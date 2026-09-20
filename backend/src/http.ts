/** JSON response + error helpers shared by the Worker and the Durable Objects. */

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

/**
 * Failure shape. API.md does not specify one, so this is the proposal:
 *   { "error": { "code": "bad_request", "message": "..." } }
 * Needs a line in API.md before the iOS side depends on it.
 */
export interface ApiErrorBody {
  error: { code: string; message: string };
}

export function errorResponse(status: number, code: string, message: string): Response {
  const body: ApiErrorBody = { error: { code, message } };
  return json(body, { status });
}

/**
 * Durable Object RPC does not preserve custom Error subclasses across the
 * boundary, so DO methods return this instead of throwing.
 */
export type DoResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string; message: string };

export function ok<T>(value: T): DoResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(status: number, code: string, message: string): DoResult<T> {
  return { ok: false, status, code, message };
}

export function toResponse<T>(result: DoResult<T>): Response {
  return result.ok
    ? json(result.value)
    : errorResponse(result.status, result.code, result.message);
}

/**
 * Thrown by request parsing at the Worker edge and turned into a response by
 * the top-level handler. Does not cross the Durable Object RPC boundary —
 * that is what DoResult is for.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  toResponse(): Response {
    return errorResponse(this.status, this.code, this.message);
  }
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, 'bad_request', message);
}
