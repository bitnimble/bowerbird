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
const SERVER = process.env.BOWERBIRD_E2E_SERVER ?? '';

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
