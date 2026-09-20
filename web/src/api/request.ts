import { z } from 'zod';
import { type ErrorEnvelope, ErrorEnvelopeSchema } from '../../../src/schemas/error';
import { PathSegment, route } from '../../../src/schemas/route';
import { describe } from '../errors';
import { type Reply, send } from './transport';

// Every URL below is same-origin: the web server proxies /api and /image through
// to the API, which the browser cannot reach itself once the web server is the
// only thing exposed. Where the API actually lives is the proxy's business
// (VITE_API_URL / VITE_API_PORT in vite.config.ts), not the client's.

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Every call below, over whichever transport is running (`transport.ts`).
 *
 * `cmd` is the caller's own name and is carried rather than used: it is what a Rust side
 * answering from a local library would match on, and until offline mode exists every one
 * of them proxies. Derived from the method and path so a new call cannot forget one.
 */
export async function request<S extends z.ZodType>(
  schema: S,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<z.output<S>> {
  let reply: Reply;
  try {
    reply = await send(commandName(method, path), method, path, body, signal);
  } catch (err) {
    // A transport only rejects when it never got an answer, so this is "API unreachable",
    // which is a different thing for the UI to say than any HTTP status.
    //
    // `describe` rather than `.message`, because the two transports do not reject alike:
    // `fetch` throws a `TypeError`, where a Tauri command that returns `Result<_, String>`
    // rejects with the bare string. Reading `.message` off that is `undefined`, so the shell
    // reported "cannot reach the API at /api/settings: undefined" and threw away the reason
    // the Rust had gone to the trouble of producing - on the one screen where the reader is
    // trying to work out why the address is wrong.
    throw new ApiError('NETWORK_ERROR', `cannot reach the API at ${path}: ${describe(err)}`, 0);
  }

  // Status first: a 502 from a reverse proxy carries no body, and reading the empty-body
  // shortcut before the status turns one into a silent success.
  const text = new TextDecoder().decode(reply.bytes);
  if (reply.status < 200 || reply.status >= 300) throw errorFrom(reply.status, text);
  return schema.parse(reply.status === 204 || text.length === 0 ? undefined : JSON.parse(text));
}

/**
 * The same call for a route that answers with a file rather than JSON.
 *
 * The name comes off `Content-Disposition` because the server is the side that knows it: an
 * export's extension follows the format it was written in, and deriving it again here would
 * be a second answer to go stale the first time a format is added.
 */
export async function requestFile(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ bytes: Uint8Array; mediaType: string; filename: string | null }> {
  let reply: Reply;
  try {
    reply = await send(commandName(method, path), method, path, body);
  } catch (err) {
    throw new ApiError('NETWORK_ERROR', `cannot reach the API at ${path}: ${describe(err)}`, 0);
  }
  if (reply.status < 200 || reply.status >= 300) {
    throw errorFrom(reply.status, new TextDecoder().decode(reply.bytes));
  }
  const disposition = reply.headers['content-disposition'] ?? '';
  const quoted = /filename="([^"]+)"/.exec(disposition);
  return {
    bytes: reply.bytes,
    mediaType: reply.headers['content-type'] ?? 'application/octet-stream',
    filename: quoted?.[1] ?? null,
  };
}

const API_PREFIX = new RegExp(`^(${route(PathSegment.api())}|${route(PathSegment.image())})/`);

/** `PATCH /api/libraries/abc/photos` becomes `patch:libraries/:id/photos`. */
function commandName(method: string, path: string): string {
  const pattern = path
    .split('?')[0]!
    .replace(API_PREFIX, '')
    .split('/')
    .map((part) => (/^[0-9a-z]{8}$/.test(part) ? ':id' : part))
    .join('/');
  return `${method.toLowerCase()}:${pattern}`;
}

export function errorFrom(status: number, text: string): ApiError {
  const envelope = envelopeOf(text);
  return new ApiError(
    envelope?.error.code ?? 'INTERNAL_ERROR',
    // A transport carries no status text, so a bodiless error has nothing else to say.
    envelope?.error.message ?? (text.slice(0, 200) || `the API answered ${status}`),
    status,
  );
}

/** The API's error envelope, or null for a body that is not one - a proxy's page, say. */
export function envelopeOf(text: string): ErrorEnvelope | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ErrorEnvelopeSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export const NothingSchema = z.undefined();
