// The shell's transport, over real IPC, in the real binary.
//
// What this covers and Playwright cannot: `api` is registered on the invoke handler, the
// request crosses as JSON, and the reply comes back as *bytes* rather than base64 with the
// status and headers framed in front of them. Every part of that only exists in a built
// app, and all of it is load-bearing - an editor open is several hundred megabytes through
// this command, which base64 would make untenable.
//
// Deliberately not asserting on any picture: what the shaders do with a frame is pinned by
// `web/e2e/gpu_parity.spec.ts` against the CPU, and the webview here has no WebGPU to grade
// with anyway (WebKitGTK is built with ENABLE_WEBGPU off, `docs/raw-edit-gpu.md` §10.1).
//
// The servers come from `scripts/e2e-tauri-full.ts`, which `e2e:tauri` runs. These used to be
// optional, and every specimen needing one skipped itself without it - so the ordinary run
// reported green over four specimens while five never executed. The RAW round-trip below was
// among them, and was timing out the whole time. Missing now is a failure, not a skip.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SERVER = process.env.BOWERBIRD_E2E_SERVER ?? '';
// A second running library, for the one case that needs two: moving between them.
const SECOND_SERVER = process.env.BOWERBIRD_E2E_SERVER_2 ?? '';
// The binary wdio launched, which `wdio.conf.ts` builds to the debug target dir.
const APP_BINARY = join(import.meta.dirname, '..', 'src-tauri', 'target', 'debug', 'app');

type Bridge = {
  __TAURI__: {
    core: { invoke: (c: string, a: unknown) => Promise<ArrayBuffer> };
    event: {
      listen: (e: string, h: (m: { payload: unknown }) => void) => Promise<() => void>;
    };
  };
};

describe('Bowerbird desktop shell', () => {
  // The address lives in a `config.json` beside the binary and survives the run that wrote
  // it, so a suite that only ever reads it inherits whatever the last one left - a port from
  // a server that is no longer there, or one of these tests' own deliberate detours if it
  // failed before its restore. Every specimen below that asserts on which library the shell
  // followed then fails for that reason rather than its own, which is a morning spent
  // reading the wrong code.
  before(async function () {
    if (SERVER === '' || SECOND_SERVER === '') {
      throw new Error('run this through `bun run e2e:tauri`, which stands the servers up');
    }
    await browser.execute(async (origin: string) => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      await invoke('set_server_origin', { value: origin });
    }, SERVER);
  });

  it('serves the bundle from the Tauri app', async () => {
    expect(await browser.getTitle()).toContain('Bowerbird');
  });

  it('exposes the Tauri IPC bridge the transport reaches for', async () => {
    const hasInvoke = await browser.execute(
      () =>
        typeof (window as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core
          ?.invoke === 'function',
    );
    expect(hasInvoke).toBe(true);
  });

  it('frames a reply as a length, a header and bytes', async () => {
    const reply = await browser.execute(async () => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      const framed = new Uint8Array(
        await invoke('api', {
          request: JSON.stringify({ cmd: 'get:libraries', method: 'GET', path: '/api/libraries' }),
        }),
      );
      const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
      const length = view.getUint32(0, true);
      const head = JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length)));
      const body = new TextDecoder().decode(framed.subarray(4 + length));
      return { head, body, framed: framed.byteLength };
    });

    expect(reply.head.status).toBe(200);
    // Lower-cased on the way through, because the page reads them by name.
    expect(reply.head.headers['content-type']).toContain('json');
    expect(reply.framed).toBeGreaterThan(4);
    expect(() => JSON.parse(reply.body)).not.toThrow();
  });

  /**
   * Whether this webview could open a RAW the way a browser tab does.
   *
   * **Recorded rather than asserted, because the answer decides an architecture.** The shell opens
   * natively and the tab opens itself, which is two paths for one job; collapsing them onto the
   * tab's is only correct if this webview has WebGPU. Tauri does not ship Chromium - WebKitGTK on
   * Linux, WKWebView on macOS, WebView2 only on Windows - and without a device the wasm decode
   * falls through to PPG, which is a *different picture* rather than a slower one.
   *
   * So this fails nothing and reports what it found. Whoever can run a bundled build on each
   * platform gets the fact; today it is guessed at, which is how the second path stays unexamined.
   */
  it('reports whether its webview has WebGPU, which decides if the native open is still needed', async () => {
    const gpu = await browser.execute(async () => {
      const adapter = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (adapter == null) return { present: false, adapter: false };
      return { present: true, adapter: (await adapter.requestAdapter()) != null };
    });
    // The finding is the point of the test, and only a human running a bundled build can collect
    // it - there is nothing to assert against, since the answer differs per platform.
    // eslint-disable-next-line no-console
    console.log(
      `[webgpu] navigator.gpu=${gpu.present} adapter=${gpu.adapter} ` +
        `- an adapter here means the shell could drop its native open and use the tab's`,
    );
    expect(typeof gpu.present).toBe('boolean');
  });

  it('prepares a RAW in the shell process rather than forwarding for it', async () => {
    // The one command this shell answers itself. What it proves is the whole reason the
    // desktop build exists: the frame is decoded here, so what crosses the network is the
    // RAW rather than the several hundred megabytes it becomes.
    const photoId = await browser.execute(async (origin: string) => {
      const libraries = (await (await fetch(`${origin}/api/libraries`)).json()) as { id: string }[];
      const listed = (await (
        await fetch(`${origin}/api/libraries/${libraries[0]!.id}/photos?limit=1`)
      ).json()) as { photos: { id: string }[] };
      return listed.photos[0]?.id ?? '';
    }, SERVER);
    expect(photoId).not.toBe('');

    const opened = await browser.execute(async (id: string) => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      const framed = new Uint8Array(
        await invoke('api', {
          request: JSON.stringify({
            cmd: 'get:prepared',
            method: 'GET',
            // The sensor's own, which is what the editor asks for. At a bounded size the
            // camera match does not fit and the frame's description is 247 bytes rather
            // than 11KB, so the path that matters would go untested.
            //
            // Spelled out rather than built by `preparedPath`, which this cannot reach: the
            // callback runs in the page, against a built bundle with no module to import
            // from. That it agrees with `preparedPath` and with the shell's `parse` is held
            // by `web/src/api/tests/prepared_path.test.ts` instead.
            path: `/image/${id}/prepared?longEdge=0`,
          }),
        }),
      );
      const view = new DataView(framed.buffer, framed.byteOffset, framed.byteLength);
      const length = view.getUint32(0, true);
      const head = JSON.parse(new TextDecoder().decode(framed.subarray(4, 4 + length)));

      const body = framed.subarray(4 + length);
      const described = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(
        0,
        true,
      );
      return {
        head,
        header: JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + described))),
        described,
        samples: body.byteLength - 4 - described,
        samplesAt: body.byteOffset + 4 + described,
      };
    }, photoId);

    expect(opened.head.status).toBe(200);
    expect(opened.header.width).toBeGreaterThan(500);
    // The description rides in the body, not in a response header: matched, it is 11KB, and
    // a reverse proxy answers 502 rather than forward one that size.
    expect(opened.head.headers['x-prepared']).toBeUndefined();
    expect(opened.header.matched).toBe(true);
    expect(opened.described).toBeGreaterThan(4096);
    // Three `u16` a pixel, at an offset a `Uint16Array` can be mapped over in place rather
    // than copying 361MB to get the alignment.
    expect(opened.samples).toBe(opened.header.width * opened.header.height * 6);
    expect(opened.samplesAt % 4).toBe(0);
  });

  it('keeps the server address beside the binary, so an unpacked build is portable', async () => {
    const before = await browser.execute(async () => {
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
      await browser.execute(async (restore: string) => {
        const { invoke } = (window as unknown as Bridge).__TAURI__.core;
        await invoke('set_server_origin', { value: restore });
      }, before);
    }
  });

  // The transport's one exception, and the only part of it a unit test cannot reach: that
  // the shell really does hold the library's SSE stream and really does put it on the IPC
  // channel the page listens to. Through the scheme this hung forever without erroring.
  it('follows the library event stream and forwards it over IPC', async () => {
    const state = await browser.execute(async () => {
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
  it('follows the address when it changes, off a server that is still running', async () => {
    const moved = await browser.execute(
      async (to: string, back: string) => {
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
      SECOND_SERVER,
      SERVER,
    );

    expect(moved).toEqual({ before: SERVER, after: SECOND_SERVER });
  });

  // The other half, and the harder one: a reader corrects the address *because* the server
  // has gone, so the follower is not connected when they do it - it is asleep in a backoff
  // that doubles to thirty seconds. A `Notify` reaches only the waits registered when it is
  // raised and there are none during a sleep, so the correction used to be dropped and took
  // effect whenever the backoff next happened to expire.
  it('takes up a corrected address without waiting out the backoff', async () => {
    try {
      const moved = await browser.execute(async (to: string) => {
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
      await browser.execute(async (restore: string) => {
        const { invoke } = (window as unknown as Bridge).__TAURI__.core;
        await invoke('set_server_origin', { value: restore });
      }, SERVER);
    }
  });

  // Against an address nothing answers, rather than against whichever one the shell happens
  // to hold. Written the second way it accepted "resolved" as a pass, which is what a
  // reachable server returns for a 404 - so in every configured run it asserted nothing about
  // unreachability, which is the whole of what it is named for.
  it('reports an unreachable server rather than panicking the shell', async () => {
    try {
      const reply = await browser.execute(async () => {
        const { invoke } = (window as unknown as Bridge).__TAURI__.core;
        // Port 1 needs root to bind, so nothing is listening and the dial is refused.
        await invoke('set_server_origin', { value: 'http://127.0.0.1:1' });
        try {
          await invoke('api', {
            request: JSON.stringify({ cmd: 'get:nothing', method: 'GET', path: '/api/nothing' }),
          });
          return 'resolved';
        } catch (error) {
          return String(error);
        }
      });
      // The reason, not merely a rejection: the shell going quiet and the shell saying why
      // are the two outcomes this tells apart, and only one of them is any use to a reader
      // looking at Settings.
      expect(reply).toContain('could not reach');
    } finally {
      await browser.execute(async (restore: string) => {
        const { invoke } = (window as unknown as Bridge).__TAURI__.core;
        await invoke('set_server_origin', { value: restore });
      }, SERVER);
    }
  });
});
