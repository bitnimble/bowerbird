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
// `BOWERBIRD_E2E_SERVER` points at a running Bowerbird for the round-trip case; without it
// the reachability case still proves the command runs and reports rather than panicking.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SERVER = process.env.BOWERBIRD_E2E_SERVER ?? '';
// The binary wdio launched, which `wdio.conf.ts` builds to the debug target dir.
const APP_BINARY = join(import.meta.dirname, '..', 'src-tauri', 'target', 'debug', 'app');

type Bridge = { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<ArrayBuffer> } } };

describe('Bowerbird desktop shell', () => {
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

  it('frames a reply as a length, a header and bytes', async function () {
    if (SERVER === '') return this.skip();

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

  it('prepares a RAW in the shell process rather than forwarding for it', async function () {
    if (SERVER === '') return this.skip();

    // The one command this shell answers itself. What it proves is the whole reason the
    // desktop build exists: the frame is decoded here, so what crosses the network is the
    // RAW rather than the several hundred megabytes it becomes.
    const photoId = await browser.execute(async (origin: string) => {
      const libraries = (await (await fetch(`${origin}/api/libraries`)).json()) as { id: string }[];
      if (libraries.length === 0) return '';
      const listed = (await (
        await fetch(`${origin}/api/libraries/${libraries[0]!.id}/photos?limit=1`)
      ).json()) as { photos: { id: string }[] };
      return listed.photos[0]?.id ?? '';
    }, SERVER);
    if (photoId === '') return this.skip();

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
    expect(opened.header.ok).toBe(true);
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

    // Beside the executable rather than in a config directory somewhere, which is what
    // makes deleting the folder the whole uninstall. As one property of a JSON object, so
    // the next app-local setting is a field rather than a second file.
    const beside = join(dirname(APP_BINARY), 'config.json');
    expect(existsSync(beside)).toBe(true);
    const written = JSON.parse(readFileSync(beside, 'utf8')) as { server?: string };
    // Trailing slash trimmed, or every path joined to it would double its first one.
    expect(written.server).toBe('http://portable.test:1234');

    await browser.execute(async (restore: string) => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      await invoke('set_server_origin', { value: restore });
    }, before);
  });

  it('reports an unreachable server rather than panicking the shell', async () => {
    const reply = await browser.execute(async () => {
      const { invoke } = (window as unknown as Bridge).__TAURI__.core;
      try {
        // A path no server serves, against whichever origin the shell was told about: the
        // failure being reported at all is what this asserts.
        await invoke('api', {
          request: JSON.stringify({ cmd: 'get:nothing', method: 'GET', path: '/api/nothing' }),
        });
        return 'resolved';
      } catch (error) {
        return String(error);
      }
    });
    // Either the server answered 404 (which resolves, framed) or it was not there at all.
    expect(reply === 'resolved' || reply.includes('could not reach')).toBe(true);
  });
});
