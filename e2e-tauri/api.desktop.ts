// The desktop shell, in the real binary: its page is served by the server it starts, and it
// answers only what a page cannot do itself.
//
// Deliberately not asserting on any picture: what the shaders do with a frame is pinned by
// `native/rawshim/tests/gpu_fixture.rs`. That a device exists at all is asserted below, and on
// Linux that needs CEF - WebKitGTK has ENABLE_WEBGPU off (`docs/raw-edit-gpu.md` §10.1), so the
// WebGPU spec is the one thing here a WebKitGTK build could never pass.
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { CDP_URL } from './shell';
import { PathSegment, route } from '../src/schemas/route';

type Bridge = { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } } };

let browser: Browser;
// One webview for the file: attaching is cheap but the shell's state is not.
let shell: Page;

test.describe.configure({ mode: 'serial' });

test.describe('Bowerbird desktop shell', () => {
  // Attached to rather than launched: `playwright.config.ts` starts the binary and waits for
  // its CDP port, so what is left here is picking the app's own page out of what that port lists.
  test.beforeAll(async () => {
    browser = await chromium.connectOverCDP(CDP_URL);
    let found: Page | undefined;
    for (let attempt = 0; attempt < 120 && found == null; attempt++) {
      found = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith('http://127.0.0.1:'));
      if (found == null) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (found == null) throw new Error('the shell never opened a page on its own server');
    shell = found;
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('opens the page its own server serves, with the sign-in off the address', async () => {
    expect(await shell.title()).toContain('Bowerbird');
    expect(new URL(shell.url()).searchParams.has('token')).toBe(false);
  });

  test('reaches its server by URL with the cookie it was signed in with, and nothing else does', async () => {
    const statuses = await shell.evaluate(
      async (path: string) => {
        const signedIn = await fetch(path);
        const stranger = await fetch(path, { credentials: 'omit' });
        return { signedIn: signedIn.status, stranger: stranger.status };
      },
      route(PathSegment.api(), PathSegment.libraries()),
    );
    expect(statuses).toEqual({ signedIn: 200, stranger: 401 });
  });

  test('is cross-origin isolated, which a page on a custom scheme never is', async () => {
    expect(await shell.evaluate(() => crossOriginIsolated)).toBe(true);
  });

  test('answers what a page cannot do', async () => {
    const answer = await shell.evaluate(async () => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      return invoke('app_data_dir', {}).then(
        () => 'answered',
        () => 'refused',
      );
    });
    expect(answer).toBe('answered');
  });

  /**
   * That this webview can open a RAW the way a browser tab does. The editor has no fall-back:
   * without a device the wasm decode falls through to PPG, which is a different picture rather
   * than a slower one, so a webview that lost WebGPU has to fail here and not quietly downstream.
   */
  test('has WebGPU in its webview, which the editor has no fall-back for', async () => {
    const gpu = await shell.evaluate(async () => {
      const adapter = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (adapter == null) return { present: false, adapter: false };
      return { present: true, adapter: (await adapter.requestAdapter()) != null };
    });
    expect(gpu.present).toBe(true);
    expect(gpu.adapter).toBe(true);
  });

  test("keeps the page's preferences in its data folder, which a new port each launch cannot lose", async () => {
    const kept = await shell.evaluate(async () => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      await invoke('write_device_file', { name: 'e2e-probe', contents: '{"kept":true}' });
      return invoke('read_device_file', { name: 'e2e-probe' });
    });
    expect(kept).toBe('{"kept":true}');
  });
});
