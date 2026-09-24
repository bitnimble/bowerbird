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

import { z } from 'zod';
import { PathSegment, route } from '../../../src/schemas/route';
import { REQUEST_ACTIVITY_HEADER, type RequestActivity } from '../../../src/schemas/request_activity';

export interface RequestOptions {
  signal?: AbortSignal;
  activity?: RequestActivity;
}

export interface Reply {
  status: number;
  headers: Record<string, string>;
  bytes: Uint8Array<ArrayBuffer>;
}

export type Invoke = (command: string, args: unknown) => Promise<unknown>;

// Android's postMessage IPC carries a binary reply as a JSON number array.
const IpcBytesSchema = z.union([z.instanceof(ArrayBuffer), z.array(z.number())]);
const ReplyHeadSchema =z.object({ status: z.number(), headers: z.record(z.string(), z.string()) });
const NullableStringSchema = z.string().nullable();

/**
 * The shell's command bridge, or null in a browser.
 *
 * Exported for the calls that are not the request contract this file exists for: a native
 * folder picker has no HTTP shape at all, and the export that follows it writes to a path the
 * page cannot reach. Synchronous, so a caller can branch on it inside a click's activation.
 */
export function shellInvoke(): Invoke | null {
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
  { signal, activity = 'interactive' }: RequestOptions = {},
): Promise<Reply> {
  const invoke = shellInvoke();
  return invoke == null
    ? await overHttp(method, path, body, { signal, activity })
    : await overIpc(invoke, { cmd, method, path, body, activity }, signal);
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
  { signal, activity = 'interactive' }: RequestOptions,
): Promise<Reply> {
  const response = await fetch(path, {
    method,
    headers: { [REQUEST_ACTIVITY_HEADER]: activity, ...(body == null ? {} : { 'Content-Type': 'application/json' }) },
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
    IpcBytesSchema.parse(await abortable(invoke('api', { request: JSON.stringify(request) }), signal)),
  );
  const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
  const length = view.getUint32(0, true);
  const head = ReplyHeadSchema.parse(JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length))));
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
  const invoke = shellInvoke();
  if (invoke == null) return null;
  return z.string().parse(await invoke('server_origin', {}));
}

/** Returns what the shell settled on, which is trimmed and may be a default. */
export async function setServerOrigin(value: string): Promise<string> {
  const invoke = shellInvoke();
  if (invoke == null) throw new Error('the server address is the desktop app’s to set');
  return z.string().parse(await invoke('set_server_origin', { value }));
}

/**
 * Where the shell keeps the catalogue, or null where there is no folder to offer.
 *
 * Null in a browser, which has no filesystem to speak of, and null on Android, where the
 * folder is real and app-private and nothing on the device can open it.
 */
export async function appDataDir(): Promise<string | null> {
  const invoke = shellInvoke();
  if (invoke == null) return null;
  return NullableStringSchema.parse(await invoke('app_data_dir', {}));
}

/** Opens it in the reader's own file manager. */
export async function openAppDataDir(): Promise<void> {
  const invoke = shellInvoke();
  if (invoke == null) return;
  await invoke('open_app_data_dir', {});
}

/** Synchronous, so a menu can decide whether to offer it. Android's shell has no chooser to show. */
export function canOpenOriginalWith(): boolean {
  return shellInvoke() != null && !/Android/i.test(navigator.userAgent);
}

/** Android's shell has no file manager to show a file in. */
export function canRevealFile(): boolean {
  return shellInvoke() != null && !/Android/i.test(navigator.userAgent);
}

/** Selects the file in the reader's own file manager. */
export async function revealFile(path: string): Promise<void> {
  const invoke = shellInvoke();
  if (invoke == null) throw new Error('showing a file in its folder is the desktop app’s to do');
  await invoke('reveal_file', { path });
}

/** The same for a photo's RAW, which rejects where the library's disk is not this device's. */
export async function revealOriginal(photoId: string): Promise<void> {
  const invoke = shellInvoke();
  if (invoke == null) throw new Error('showing a file in its folder is the desktop app’s to do');
  await invoke('reveal_original', { photoId });
}

/** Resolves once the reader has picked an app from the platform's chooser, or dismissed it. */
export async function openOriginalWith(photoId: string): Promise<void> {
  const invoke = shellInvoke();
  if (invoke == null) throw new Error('opening a RAW in another app is the desktop app’s to do');
  await invoke('open_original_with', { photoId });
}

/** A subscription to the library's events, however this build happens to receive them. */
export interface EventStream {
  close(): void;
}

export interface EventHandlers {
  /**
   * Every (re)connect, so a view holding a request that died with the server re-asks.
   *
   * `reconnect` is false for exactly one case: a stream that was already up when this
   * subscribed, which is the baseline the view was rendered against and carries no news. A
   * stream that comes up *after* is a library that was unreachable and now is not - whether
   * or not this page ever saw it up - and that is what a view has to re-ask on.
   */
  open(reconnect: boolean): void;
  rendition(data: string): void;
  replication(data: string): void;
  composite(data: string): void;
  export(data: string): void;
}

// Every event kind that carries a payload, so adding one is this line and a
// handler. `open` is not among them: it is the connection, not something on it.
const KINDS = [
  'rendition',
  'replication',
  'composite',
  'export',
] as const satisfies readonly (keyof EventHandlers)[];

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
  const source = new EventSource(route(PathSegment.api(), PathSegment.events()));
  // Which is also why the first connect is the baseline: a page served by the API cannot have
  // loaded while the API was unreachable, so only the connects after it are a server coming
  // back. The shell is the build where that does not hold.
  let seen = false;
  source.addEventListener('open', () => {
    handlers.open(seen);
    seen = true;
  });
  for (const kind of KINDS) {
    source.addEventListener(kind, (event) => handlers[kind]((event as MessageEvent<string>).data));
  }
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
 * And the stream is usually already up by the time any of this runs - it connects at startup,
 * where a browser's `EventSource` connects when the page asks it to. A Tauri event reaches
 * only whoever is listening when it is emitted, so that `open` was emitted before there was a
 * listener and this would never hear it. It asks for the state instead, which is the same
 * question the event answers - and the answer is also what says which kind of open the next
 * one is.
 *
 * `null` from the probe means the stream is *down*: the shell renders from its embedded
 * bundle, so a page can be up and complete against a library that is not there. The `open`
 * that eventually arrives is then a server becoming reachable rather than a baseline, and
 * treating it as the first connect left every failed thumbnail a placeholder for the life of
 * the page.
 */
function overIpcEvents(listen: Listen, handlers: EventHandlers): EventStream {
  let stop: (() => void) | null = null;
  let closed = false;
  // Whether the page has been told where it stands. Only the probe can settle it without a
  // reconnect, and only if it wins the race - a real `open` arriving first settles it too,
  // and as the reconnect it is.
  let settled = false;

  const open = (reconnect: boolean): void => {
    if (closed || (settled && !reconnect)) return;
    settled = true;
    handlers.open(reconnect);
  };

  void listen('library:event', ({ payload }) => {
    const { kind, data } = payload as { kind: string; data: string };
    if (kind === 'open') {
      // Always a reconnect: this is the shell dialling, which it does at startup before the
      // probe and again every time a connection ends. Either way the library is reachable
      // now and was not a moment ago.
      open(true);
    } else {
      const carried = KINDS.find((known) => known === kind);
      if (carried != null) handlers[carried](data);
    }
  }).then((unlisten) => {
    if (closed) unlisten();
    else stop = unlisten;
  });

  const invoke = shellInvoke();
  if (invoke != null) {
    void invoke('events_following', {}).then((library) => {
      if (NullableStringSchema.parse(library) != null) open(false);
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
