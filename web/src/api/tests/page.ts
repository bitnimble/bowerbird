/** Where the page under test was loaded from, which decides whether it reaches its server through the shell. */
export function loadedFrom(url: string): void {
  const { protocol, hostname } = new URL(url);
  Object.defineProperty(globalThis, 'location', { value: { protocol, hostname }, configurable: true });
}

export function unload(): void {
  delete (globalThis as { location?: unknown }).location;
}

/** Android's page, which the shell bundles. */
export const BUNDLED = 'http://tauri.localhost/';

/** The desktop's page, which its own server serves. */
export const SERVED = 'http://127.0.0.1:4100/';
