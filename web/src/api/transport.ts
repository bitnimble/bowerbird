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
 * one caller with a shape of its own - the editor's open, whose frame is framed into its
 * body so the samples read straight into a texture upload - works the same way on both
 * sides.
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

type Invoke = <T>(command: string, args: unknown) => Promise<T>;

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
    : await overIpc(invoke, { cmd, method, path, body }, signal);
}

/**
 * The caller's abort, over a transport that has none.
 *
 * Tauri's IPC cannot cancel a command in flight, so the shell's Rust runs to completion
 * either way. What the caller is actually asking for is that an abandoned request stop
 * being an answer - a scroll outruns its blocks, and the stale one must not land on top of
 * the fresh one - and that is the rejection rather than the saved work. Without this the
 * list calls abort in the browser and quietly do not in the app, which is the same request
 * resolving twice in a different order on the two.
 */
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal == null) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  ]);
}

async function overHttp(
  method: string,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Reply> {
  const response = await fetch(path, {
    method,
    headers: body == null ? undefined : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
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
 *
 * A view over the body, never a copy. The Rust side pads the JSON to a multiple of four so
 * the body lands four-byte aligned, which is what lets the editor take a `Uint16Array` over
 * these same bytes: at 61MP the copying version held three 361MB arrays at once for a
 * payload that is read exactly twice.
 */
async function overIpc(invoke: Invoke, request: unknown, signal?: AbortSignal): Promise<Reply> {
  const framed = new Uint8Array(
    await abortable(invoke<ArrayBuffer>('api', { request: JSON.stringify(request) }), signal),
  );
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const length = view.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length))) as {
    status: number;
    headers: Record<string, string>;
  };
  return { status: head.status, headers: head.headers, bytes: framed.subarray(4 + length) };
}

/**
 * Where the shell is pointed, and where to point it.
 *
 * The one setting that cannot live with the others, because the others are on the far side
 * of it: asking the server where the server is does not work. So the shell keeps it beside
 * its own config, and the browser has no use for it at all - a page already knows its
 * origin.
 */
export async function serverOrigin(): Promise<string | null> {
  const invoke = invoker();
  if (invoke == null) return null;
  return await invoke<string>('server_origin', {});
}

/** Returns what the shell settled on, which is trimmed and may be a default. */
export async function setServerOrigin(value: string): Promise<string> {
  const invoke = invoker();
  if (invoke == null) throw new Error('the server address is the desktop app’s to set');
  return await invoke<string>('set_server_origin', { value });
}

/** A subscription to the library's events, however this build happens to receive them. */
export interface EventStream {
  close(): void;
}

export interface EventHandlers {
  /** Every (re)connect, so a view holding a request that died with the server re-asks. */
  open(): void;
  rendition(data: string): void;
}

/**
 * The library's events, over whichever transport is running.
 *
 * The one call that is not request/response, and so the one that cannot go through `send`
 * or through `assetUrl` either. A browser opens its own connection and this is an
 * `EventSource`; the shell cannot proxy the stream at all, because `UriSchemeResponder`
 * takes a whole response and this body never ends - so its Rust holds the stream and
 * forwards each event over IPC, and this is the seam that hides which of the two happened.
 */
export function subscribeEvents(handlers: EventHandlers): EventStream {
  const listen = listener();
  return listen == null ? overEventSource(handlers) : overIpcEvents(listen, handlers);
}

type Listen = (
  event: string,
  handler: (message: { payload: unknown }) => void,
) => Promise<() => void>;

function listener(): Listen | null {
  const bridge = (globalThis as { __TAURI__?: { event?: { listen?: unknown } } }).__TAURI__;
  const listen = bridge?.event?.listen;
  return typeof listen === 'function' ? (listen as Listen) : null;
}

function overEventSource(handlers: EventHandlers): EventStream {
  // Its own origin, not `assetUrl`: the page and the API are the same server here.
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => handlers.open());
  source.addEventListener('rendition', (event) =>
    handlers.rendition((event as MessageEvent<string>).data),
  );
  return { close: () => source.close() };
}

/**
 * The same events, arriving as Tauri events from `src-tauri/src/events.rs`.
 *
 * Closing stops this page listening; it does not stop the stream, which belongs to the app
 * rather than to the view and carries a `Last-Event-ID` across reconnects so nothing that
 * happened while a view was away is lost.
 *
 * `listen` resolves after a round trip, so a subscription closed before it lands has to
 * unlisten on arrival rather than leave the handler registered.
 *
 * And the stream is already up by the time any of this runs - it connects at startup, where
 * a browser's `EventSource` connects when the page asks it to. A Tauri event reaches only
 * whoever is listening when it is emitted, so the `open` was emitted before there was a
 * listener and this would never call `open()` at all. It asks for the state instead, which
 * is the same question the event answers.
 */
function overIpcEvents(listen: Listen, handlers: EventHandlers): EventStream {
  let stop: (() => void) | null = null;
  let closed = false;
  let opened = false;

  const open = (): void => {
    if (closed || opened) return;
    opened = true;
    handlers.open();
  };

  void listen('library:event', ({ payload }) => {
    const { kind, data } = payload as { kind: string; data: string };
    if (kind === 'open') {
      // A reconnect is a fresh `open`, and the point of one: a view holding a request that
      // died with the server has to be told to ask again.
      opened = false;
      open();
    } else if (kind === 'rendition') {
      handlers.rendition(data);
    }
  }).then((unlisten) => {
    if (closed) unlisten();
    else stop = unlisten;
  });

  const invoke = invoker();
  if (invoke != null) {
    void invoke<string | null>('events_following', {}).then((library) => {
      if (library != null) open();
    });
  }

  return {
    close(): void {
      closed = true;
      stop?.();
      stop = null;
    },
  };
}

/**
 * A URL an `<img>` or a download can load, which cannot go through `send`.
 *
 * The browser fetches those itself, so under the shell they need a scheme its Rust
 * answers. Same paths either way; only the prefix moves.
 *
 * And the prefix is not one string. A registered scheme is served at `bowerbird://localhost`
 * on macOS and Linux but at `http://bowerbird.localhost` on Windows and Android, which are
 * the two targets that gained a build here - hardcoding either form 404s every rendition,
 * download and event stream on the other. Only the injected script knows which, so it is
 * asked rather than guessed: `convertFileSrc` percent-encodes what it is handed, so it is
 * handed nothing and the path is appended after.
 */
export function assetUrl(path: string): string {
  const convert = (
    globalThis as {
      __TAURI_INTERNALS__?: { convertFileSrc?: (file: string, protocol: string) => string };
    }
  ).__TAURI_INTERNALS__?.convertFileSrc;
  if (typeof convert !== 'function') return path;
  return convert('', 'bowerbird').replace(/\/$/, '') + path;
}
