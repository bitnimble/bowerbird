/**
 * One request contract, two transports.
 *
 * The browser talks to the API over HTTP; the desktop shell hands the same request to its
 * own Rust, which today forwards it to the hosted Bowerbird server and tomorrow will
 * answer some of it from a local library. Neither the callers above this file nor the
 * Rust below it know which one is running - that is the point, and it is why offline mode
 * can arrive without touching a single call site.
 *
 * The convergence is on HTTP's shape rather than on a bespoke one. A status, a set of
 * headers and some bytes is what the server already answers with, so a proxy is the
 * identity function and a local handler has an obvious contract to meet. It also means the
 * one caller that needs a response header - the editor's open carries its `PreparedHeader`
 * in `X-Prepared`, so the frame reads straight into a texture upload - works the same way
 * on both sides.
 */

export interface Reply {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Whether this is the desktop shell rather than a page. */
export function isTauri(): boolean {
  return invoker() != null;
}

type Invoke = (command: string, args: unknown) => Promise<ArrayBuffer>;

function invoker(): Invoke | null {
  const bridge = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
  const invoke = bridge?.core?.invoke;
  return typeof invoke === 'function' ? (invoke as Invoke) : null;
}

/**
 * One request, whichever side of the app is running.
 *
 * `cmd` names what is being asked for. Nothing reads it yet - every command proxies - and
 * it is carried anyway because it is the seam: a Rust side that answers `getPhoto` from a
 * local database matches on that name, and falls through to the proxy for the rest.
 */
export async function send(
  cmd: string,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<Reply> {
  const invoke = invoker();
  return invoke == null
    ? await overHttp(method, path, body, signal)
    : await overIpc(invoke, { cmd, method, path, body });
}

async function overHttp(
  method: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Reply> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal != null && { signal }),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
  return { status: response.status, headers, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/**
 * The same reply, framed: a `u32` length, that much JSON, then the body.
 *
 * Tauri carries a `Response` as a binary body rather than as base64, which is what makes
 * an open of several hundred megabytes viable over IPC at all - but a binary body is all
 * it carries, so the status and headers travel in front of it rather than beside it.
 */
async function overIpc(invoke: Invoke, request: unknown): Promise<Reply> {
  const framed = new Uint8Array(await invoke('api', { request: JSON.stringify(request) }));
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const length = view.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length))) as {
    status: number;
    headers: Record<string, string>;
  };
  // Copied rather than viewed: the body starts at a header-dependent offset, which is
  // almost never the alignment the typed arrays over it need.
  const bytes = new Uint8Array(framed.byteLength - 4 - length);
  bytes.set(framed.subarray(4 + length));
  return { status: head.status, headers: head.headers, bytes };
}

/**
 * A URL an `<img>` or an `EventSource` can load, which cannot go through `send`.
 *
 * The browser fetches those itself, so under the shell they need a scheme its Rust
 * answers. Same paths either way; only the prefix moves.
 */
export function assetUrl(path: string): string {
  return isTauri() ? `bowerbird://localhost${path}` : path;
}
