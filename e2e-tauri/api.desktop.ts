// The shell's transport, over real IPC, in the real binary.
//
// What this covers and the `web/e2e` suite cannot: `api` is registered on the invoke handler,
// the request crosses as JSON, and the reply comes back as *bytes* rather than base64 with the
// status and headers framed in front of them. Every part of that only exists in a built app,
// and all of it is load-bearing - an editor open is several hundred megabytes through this
// command, which base64 would make untenable.
//
// Deliberately not asserting on any picture: what the shaders do with a frame is pinned by
// `native/rawshim/tests/gpu_fixture.rs`. That a device exists at all is asserted below, and on
// Linux that needs CEF - WebKitGTK has ENABLE_WEBGPU off (`docs/raw-edit-gpu.md` §10.1), so the
// WebGPU spec is the one thing here a WebKitGTK build could never pass.
//
// The servers come from `scripts/e2e-tauri-full.ts`, which `e2e:tauri` runs. These used to be
// optional, and every specimen needing one skipped itself without it - so the ordinary run
// reported green over four specimens while five never executed. The RAW round-trip below was
// among them, and was timing out the whole time. Missing now is a failure, not a skip.
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { APP_BINARY, CDP_URL } from './shell';
import { PathSegment, route } from '../src/schemas/route';
import { REQUEST_ACTIVITY_HEADER } from '../src/schemas/request_activity';

const SERVER = process.env.BOWERBIRD_E2E_SERVER ?? '';
// A second running library, for the one case that needs two: moving between them.
const SECOND_SERVER = process.env.BOWERBIRD_E2E_SERVER_2 ?? '';

type Bridge = {
  __TAURI__: {
    core: { invoke: (c: string, a: unknown) => Promise<ArrayBuffer> };
    event: {
      listen: (e: string, h: (m: { payload: unknown }) => void) => Promise<() => void>;
    };
  };
  __TAURI_INTERNALS__: {
    convertFileSrc: (file: string, protocol: string) => string;
  };
};

let browser: Browser;
// One webview for the file, not one per test: attaching is cheap but the shell's state is
// not, and these specimens deliberately hand each other a shell that is already running.
let shell: Page;

// The address lives in a `config.json` beside the binary and survives the run that wrote it,
// so a suite that only ever reads it inherits whatever the last one left - a port from a
// server that is no longer there, or one of these tests' own deliberate detours if it failed
// before its restore. Every specimen below that asserts on which library the shell followed
// then fails for that reason rather than its own, which is a morning spent reading the wrong
// code. Serial for the same reason: they share one webview and one config file.
test.describe.configure({ mode: 'serial' });

test.describe('Bowerbird desktop shell', () => {
  // Attached to rather than launched: `playwright.config.ts` starts the binary and waits for
  // its CDP port, so what is left here is picking the app's own page out of what that port
  // lists.
  test.beforeAll(async () => {
    if (SERVER === '' || SECOND_SERVER === '') {
      throw new Error('run this through `bun run e2e:tauri`, which stands the servers up');
    }
    browser = await chromium.connectOverCDP(CDP_URL);
    let found: Page | undefined;
    for (let attempt = 0; attempt < 40 && found == null; attempt++) {
      found = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().startsWith('http://tauri.localhost'));
      if (found == null) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (found == null) throw new Error('the shell never opened a page on tauri.localhost');
    shell = found;

    await shell.evaluate(async (origin: string) => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      await invoke('set_server_origin', { value: origin });
    }, SERVER);
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  test('serves the bundle from the Tauri app', async () => {
    expect(await shell.title()).toContain('Bowerbird');
  });

  test('exposes the Tauri IPC bridge the transport reaches for', async () => {
    const hasInvoke = await shell.evaluate(
      () =>
        typeof (window as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core
          ?.invoke === 'function',
    );
    expect(hasInvoke).toBe(true);
  });

  test('frames a reply as a length, a header and bytes', async () => {
    const reply = await shell.evaluate(async (path: string) => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      const framed = new Uint8Array(
        await invoke('api', {
          request: JSON.stringify({ cmd: 'get:libraries', method: 'GET', path }),
        }),
      );
      const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
      const length = view.getUint32(0, true);
      const head = JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length)));
      const body = new TextDecoder().decode(framed.subarray(4 + length));
      return { head, body, framed: framed.byteLength };
    }, route(PathSegment.api(), PathSegment.libraries()));

    expect(reply.head.status).toBe(200);
    // Lower-cased on the way through, because the page reads them by name.
    expect(reply.head.headers['content-type']).toContain('json');
    expect(reply.framed).toBeGreaterThan(4);
    expect(() => JSON.parse(reply.body)).not.toThrow();
  });

  test('forwards an activity-marked asset request through its custom scheme', async () => {
    const result = await shell.evaluate(async ({ header, path }) => {
      const { convertFileSrc } = (window as unknown as Bridge).__TAURI_INTERNALS__;
      const prefix = convertFileSrc('', 'bowerbird').replace(/\/$/, '');
      try {
        const reply = await fetch(`${prefix}${path}`, { headers: { [header]: 'interactive' } });
        return { status: reply.status, error: null };
      } catch (error) {
        return { status: 0, error: String(error) };
      }
    }, {
      header: REQUEST_ACTIVITY_HEADER,
      path: route(PathSegment.image(), 'missing-photo', PathSegment.download(), 'original'),
    });

    expect(result).toEqual({ status: 404, error: null });
  });

  /**
   * That this webview can open a RAW the way a browser tab does.
   *
   * **The editor has no fall-back left, so this is an assertion rather than a note.** The shell
   * opened natively until every platform's webview became Chromium - CEF on Linux, WebView2 on
   * Windows, and the same engine on macOS - and that one path is the whole editor now. Without a
   * device the wasm decode falls through to PPG, which is a *different picture* rather than a
   * slower one, so a webview that lost WebGPU has to fail here and not quietly downstream.
   */
  test('has WebGPU in its webview, which the editor now has no fall-back for', async () => {
    const gpu = await shell.evaluate(async () => {
      const adapter = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (adapter == null) return { present: false, adapter: false };
      return { present: true, adapter: (await adapter.requestAdapter()) != null };
    });
    expect(gpu.present).toBe(true);
    expect(gpu.adapter).toBe(true);
  });

  test('keeps the server address beside the binary, so an unpacked build is portable', async () => {
    const before = await shell.evaluate(async () => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      const held = (await invoke('server_origin', {})) as unknown as string;
      await invoke('set_server_origin', { value: 'http://portable.test:1234/' });
      return held;
    });

    // Restored whatever the assertions do. Left to the happy path, a failure here wrote
    // `http://portable.test:1234` into the config beside the binary and left it there, so
    // every later test in the file - and every later run - pointed the shell at a host that
    // does not exist, and failed for a reason that had nothing to do with them.
    try {
      // Beside the executable rather than in a config directory somewhere, which is what
      // makes deleting the folder the whole uninstall. As one property of a JSON object, so
      // the next app-local setting is a field rather than a second file.
      const beside = join(dirname(APP_BINARY), 'config.json');
      expect(existsSync(beside)).toBe(true);
      const written = JSON.parse(readFileSync(beside, 'utf8')) as { server?: string };
      // Trailing slash trimmed, or every path joined to it would double its first one.
      expect(written.server).toBe('http://portable.test:1234');
    } finally {
      await shell.evaluate(async (restore: string) => {
        const { invoke } = (window as unknown as Bridge).__TAURI__.core;
        await invoke('set_server_origin', { value: restore });
      }, before);
    }
  });

  // The transport's one exception, and the only part of it a unit test cannot reach: that
  // the shell really does hold the library's SSE stream and really does put it on the IPC
  // channel the page listens to. Through the scheme this hung forever without erroring.
  test('follows the library event stream and forwards it over IPC', async () => {
    const state = await shell.evaluate(async () => {
      const { core } = (window as unknown as Bridge).__TAURI__;
      const origin = (await core.invoke('server_origin', {})) as unknown as string;
      // Polled rather than sampled: the stream is dialled at startup and reconnects with a
      // backoff, so the answer depends on where in that the page happens to ask.
      for (let attempt = 0; attempt < 40; attempt++) {
        const following = (await core.invoke('events_following', {})) as unknown as string | null;
        if (following != null) return { origin, connected: true };
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return { origin, connected: false };
    });

    // Both at once, so a failure says which server it followed rather than only that it did
    // not connect to something.
    expect(state).toEqual({ origin: SERVER, connected: true });
  });

  // Changing the address has to move the stream, and that is not automatic: a connection is
  // only re-dialled when the current one ends, and a server that is still running never ends
  // one - its heartbeat holds the socket open for as long as the process lives. So the shell
  // stayed on the library the reader had just left, reporting itself connected the whole
  // time.
  test('follows the address when it changes, off a server that is still running', async () => {
    const moved = await shell.evaluate(
      async ([to, back]: [string, string]) => {
        const { core } = (window as unknown as Bridge).__TAURI__;
        // Which library, not whether: a connection to the one just left still answers
        // "connected", which is exactly how this looked like it worked.
        const following = async (): Promise<string | null> =>
          (await core.invoke('events_following', {})) as unknown as string | null;

        for (let attempt = 0; attempt < 40 && (await following()) == null; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        const before = await following();

        await core.invoke('set_server_origin', { value: to });
        // It has to drop the old connection and take up the new one. Both are running, so
        // nothing but the notify can end the first.
        let after: string | null = null;
        for (let attempt = 0; attempt < 40; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          after = await following();
          if (after === to) break;
        }
        await core.invoke('set_server_origin', { value: back });
        return { before, after };
      },
      [SECOND_SERVER, SERVER] as [string, string],
    );

    expect(moved).toEqual({ before: SERVER, after: SECOND_SERVER });
  });

  // The other half, and the harder one: a reader corrects the address *because* the server
  // has gone, so the follower is not connected when they do it - it is asleep in a backoff
  // that doubles to thirty seconds. A `Notify` reaches only the waits registered when it is
  // raised and there are none during a sleep, so the correction used to be dropped and took
  // effect whenever the backoff next happened to expire.
  test('takes up a corrected address without waiting out the backoff', async () => {
    try {
      const moved = await shell.evaluate(async (to: string) => {
        const { core } = (window as unknown as Bridge).__TAURI__;
        const following = async (): Promise<string | null> =>
          (await core.invoke('events_following', {})) as unknown as string | null;
        const rest = (ms: number): Promise<unknown> =>
          new Promise((resolve) => setTimeout(resolve, ms));

        // Nothing can be listening on port 1, so every dial is refused in milliseconds.
        await core.invoke('set_server_origin', { value: 'http://127.0.0.1:1' });
        let left = false;
        for (let attempt = 0; attempt < 40 && !left; attempt++) {
          left = (await following()) == null;
          if (!left) await rest(250);
        }
        // Long enough for the backoff to have doubled well past the window asserted below,
        // so waiting one out and reacting to the change are told apart.
        await rest(8000);

        await core.invoke('set_server_origin', { value: to });
        const asked = Date.now();
        for (let attempt = 0; attempt < 12; attempt++) {
          if ((await following()) === to) return { left, took: Date.now() - asked };
          await rest(250);
        }
        return { left, took: -1 };
      }, SERVER);

      // Reported rather than merely waited for. Left silent, this loop's timeout was the
      // whole test's escape hatch: a shell that ignored the address change never leaves
      // SERVER, so it is still following it when the origin is set back, and the wait below
      // returns instantly. The test passed against exactly the thing it was written to catch.
      // `left` false means the follower never left the address it was told to leave.
      expect(moved.left).toBe(true);
      expect(moved.took).toBeGreaterThanOrEqual(0);
      expect(moved.took).toBeLessThan(3000);
    } finally {
      await shell.evaluate(async (restore: string) => {
        const { invoke } = (window as unknown as Bridge).__TAURI__.core;
        await invoke('set_server_origin', { value: restore });
      }, SERVER);
    }
  });

  // Against an address nothing answers, rather than against whichever one the shell happens
  // to hold. Written the second way it accepted "resolved" as a pass, which is what a
  // reachable server returns for a 404 - so in every configured run it asserted nothing about
  // unreachability, which is the whole of what it is named for.
  test('reports an unreachable server rather than panicking the shell', async () => {
    try {
      const reply = await shell.evaluate(async (path: string) => {
        const { invoke } = (window as unknown as Bridge).__TAURI__.core;
        // Port 1 needs root to bind, so nothing is listening and the dial is refused.
        await invoke('set_server_origin', { value: 'http://127.0.0.1:1' });
        try {
          await invoke('api', {
            request: JSON.stringify({ cmd: 'get:nothing', method: 'GET', path }),
          });
          return 'resolved';
        } catch (error) {
          return String(error);
        }
      }, route(PathSegment.api(), 'nothing'));
      // The reason, not merely a rejection: the shell going quiet and the shell saying why
      // are the two outcomes this tells apart, and only one of them is any use to a reader
      // looking at Settings.
      expect(reply).toContain('could not reach');
    } finally {
      await shell.evaluate(async (restore: string) => {
        const { invoke } = (window as unknown as Bridge).__TAURI__.core;
        await invoke('set_server_origin', { value: restore });
      }, SERVER);
    }
  });
});
