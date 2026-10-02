/**
 * The page's requests to the server that served it, and the shell's commands where the page is
 * running inside the app.
 */

import { z } from 'zod';
import { PathSegment, route } from '../../../src/schemas/route';
import {
  REQUEST_ACTIVITY_HEADER,
  type RequestActivity,
} from '../../../src/schemas/request_activity';

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

const NullableStringSchema = z.string().nullable();

/**
 * The shell's command bridge, or null in a browser.
 *
 * A native folder picker has no HTTP shape at all, and the export that follows it writes to a
 * path the page cannot reach. Synchronous, so a caller can branch on it inside a click's
 * activation.
 */
export function shellInvoke(): Invoke | null {
  const bridge = (globalThis as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__;
  const invoke = bridge?.core?.invoke;
  return typeof invoke === 'function' ? (invoke as Invoke) : null;
}

/** The mobile app, which has no file manager or app chooser to hand anything to. */
export function inMobileApp(): boolean {
  if (shellInvoke() == null) return false;
  const agent = navigator.userAgent;
  // An iPad's webview names itself a Mac.
  return /Android|iPhone|iPad/i.test(agent) || (/Mac/i.test(agent) && navigator.maxTouchPoints > 1);
}

export async function send(
  method: string,
  path: string,
  body?: unknown,
  { signal, activity = 'interactive' }: RequestOptions = {},
): Promise<Reply> {
  const response = await fetch(path, {
    method,
    headers: {
      [REQUEST_ACTIVITY_HEADER]: activity,
      ...(body == null ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body == null ? undefined : JSON.stringify(body),
    ...(signal != null && { signal }),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
  return { status: response.status, headers, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** Zooms the app's page; a browser has its own zoom, so there it does nothing. */
export async function applyUiScale(scale: number): Promise<void> {
  if (scalesOwnViewport()) {
    scaleViewport(scale);
    return;
  }
  await shellInvoke()?.('set_ui_scale', { value: scale });
}

/** A file the app keeps for this device's page, or null where it has none yet. */
export async function readDeviceFile(invoke: Invoke, name: string): Promise<string | null> {
  return NullableStringSchema.parse(await invoke('read_device_file', { name }));
}

export async function writeDeviceFile(
  invoke: Invoke,
  name: string,
  contents: string,
): Promise<void> {
  await invoke('write_device_file', { name, contents });
}

/**
 * Android's webview has no page zoom for the shell to set, so the page scales its viewport: an
 * initial scale with no width lays the page out that much narrower, as a page zoom does.
 */
function scaleViewport(scale: number): void {
  document
    .querySelector('meta[name="viewport"]')
    ?.setAttribute('content', `initial-scale=${scale}`);
}

function scalesOwnViewport(): boolean {
  return inMobileApp() && /Android/i.test(navigator.userAgent);
}

/**
 * Where the shell keeps the catalogue, or null where there is no folder to offer.
 *
 * Null in a browser, which has no filesystem to speak of, and null in the mobile app, where the
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

/** Synchronous, so a menu can decide whether to offer it. The mobile app has no chooser to show. */
export function canOpenOriginalWith(): boolean {
  return shellInvoke() != null && !inMobileApp();
}

/** macOS has no chooser dialog, so the shell pops a menu of applications at the pointer instead. */
export function opensWithAMenu(): boolean {
  return canOpenOriginalWith() && /Mac/i.test(navigator.userAgent);
}

/** Minimises, maximises or closes the app's own window, for the caption buttons drawn in place of its title bar. */
export async function windowCommand(
  command: 'minimize' | 'toggle_maximize' | 'close',
): Promise<void> {
  const invoke = shellInvoke();
  if (invoke == null) throw new Error('the window is the desktop app’s to manage');
  await invoke(`plugin:window|${command}`, {});
}

export async function windowIsMaximized(): Promise<boolean> {
  const invoke = shellInvoke();
  if (invoke == null) return false;
  return z.boolean().parse(await invoke('plugin:window|is_maximized', {}));
}

const CaptionButtonSchema = z.enum(['minimize', 'maximize', 'close']);
const CaptionPointerSchema = z.object({
  hovered: CaptionButtonSchema.nullable(),
  pressed: CaptionButtonSchema.nullable(),
});
export type CaptionButton = z.infer<typeof CaptionButtonSchema>;
export type CaptionPointer = z.infer<typeof CaptionPointerSchema>;

/** Sizes the shell's window over the caption buttons, in physical pixels; zero hides it. */
export async function setCaptionButtonsSize(width: number, height: number): Promise<void> {
  const invoke = shellInvoke();
  if (invoke == null) return;
  await invoke('set_caption_buttons', { width, height });
}

/** That window takes the buttons' pointer input, so the shell says which to draw hovered or pressed. */
export function followCaptionPointer(handler: (pointer: CaptionPointer) => void): () => void {
  const listen = listener();
  if (listen == null) return () => {};
  const unlisten = listen('caption-buttons', ({ payload }) =>
    handler(CaptionPointerSchema.parse(payload)),
  );
  return () => void unlisten.then((stop) => stop());
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

/** The mobile app has no file manager to show a file in. */
export function canRevealFile(): boolean {
  return shellInvoke() != null && !inMobileApp();
}

/** Selects the file in the reader's own file manager. */
export async function revealFile(path: string): Promise<void> {
  const invoke = shellInvoke();
  if (invoke == null) throw new Error('showing a file in its folder is the desktop app’s to do');
  await invoke('reveal_file', { path });
}

/** Opens a folder in the reader's own file manager. */
export async function openFolder(path: string): Promise<void> {
  const invoke = shellInvoke();
  if (invoke == null) throw new Error('opening a folder is the desktop app’s to do');
  await invoke('open_folder', { path });
}

/** The same for a photo's RAW, which rejects where this device holds no copy of it. */
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

/** A subscription to the library's events. */
export interface EventStream {
  close(): void;
}

export interface EventHandlers {
  /**
   * Every (re)connect, so a view holding a request that died with the server re-asks.
   *
   * `reconnect` is false for the first connect only: a page served by the API cannot have loaded
   * while the API was unreachable, so that one is the baseline the view was rendered against.
   */
  open(reconnect: boolean): void;
  rendition(data: string): void;
  rendition_fetch(data: string): void;
  replication(data: string): void;
  backup(data: string): void;
  composite(data: string): void;
  export(data: string): void;
}

// Every event kind that carries a payload, so adding one is this line and a
// handler. `open` is not among them: it is the connection, not something on it.
const KINDS = [
  'rendition',
  'rendition_fetch',
  'replication',
  'backup',
  'composite',
  'export',
] as const satisfies readonly (keyof EventHandlers)[];

export function subscribeEvents(handlers: EventHandlers): EventStream {
  const source = new EventSource(route(PathSegment.api(), PathSegment.events()));
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
