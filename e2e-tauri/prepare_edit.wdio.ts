// The editor's open, over real IPC, in the real shell.
//
// What this covers and Playwright cannot: `prepare_edit` runs `rawshim::edit::prepare` in
// the app's own process, on its own threads, and hands back tens of megabytes through
// Tauri's binary IPC. Every part of that - the command being registered, the request
// crossing as JSON, the frame coming back as bytes rather than base64, the framing the
// client then splits - only exists in a built binary.
//
// Deliberately not asserting on the picture: what the shaders do with these samples is
// pinned by `web/e2e/gpu_parity.spec.ts` against the CPU, and the webview here has no
// WebGPU to grade with anyway (WebKitGTK is built with ENABLE_WEBGPU off,
// `docs/raw-edit-gpu.md` §10.1).
const RAW = process.env.BOWERBIRD_E2E_RAW ?? '';

describe('Bowerbird desktop shell', () => {
  it('serves the bundle from the Tauri app', async () => {
    expect(await browser.getTitle()).toContain('Bowerbird');
  });

  it('exposes the Tauri IPC bridge the editor reaches for', async () => {
    const hasInvoke = await browser.execute(
      () =>
        typeof (window as { __TAURI__?: { core?: { invoke?: unknown } } }).__TAURI__?.core
          ?.invoke === 'function',
    );
    expect(hasInvoke).toBe(true);
  });

  it('opens a RAW in the shell process and returns the prepared frame', async function () {
    if (RAW === '') return this.skip();

    const summary = await browser.execute(async (path: string) => {
      const invoke = (window as unknown as {
        __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<ArrayBuffer> } };
      }).__TAURI__.core.invoke;
      const reply = new Uint8Array(
        await invoke('prepare_edit', {
          request: JSON.stringify({
            rawFilePath: path,
            longEdge: 1024,
            grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.995 },
            strengths: { luma: 1, chroma: 1, sharpen: 1, defringe: 1 },
          }),
        }),
      );
      const view = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      const length = view.getUint32(0, true);
      const header = JSON.parse(new TextDecoder().decode(reply.subarray(4, 4 + length)));
      return { header, bytes: reply.byteLength };
    }, RAW);

    expect(summary.header.ok).toBe(true);
    // The frame is real: three `u16` a pixel, and the header says how many.
    expect(summary.header.samplesLen).toBe(summary.header.width * summary.header.height * 6);
    expect(summary.bytes).toBeGreaterThan(summary.header.samplesLen);
    expect(summary.header.width).toBeGreaterThan(500);
    // The camera match is what the client grades through, and it has to survive the
    // crossing as arrays rather than as a Rust struct.
    if (summary.header.matched) {
      expect(summary.header.colour.curves.length).toBe(3);
      expect(summary.header.colour.curves[0].length).toBeGreaterThan(16);
    }
  });

  it('reports a bad path rather than panicking the shell', async () => {
    const reply = await browser.execute(async () => {
      const invoke = (window as unknown as {
        __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<unknown> } };
      }).__TAURI__.core.invoke;
      try {
        await invoke('prepare_edit', {
          request: JSON.stringify({
            rawFilePath: '/nonexistent/frame.arw',
            longEdge: 512,
            grade: { peakNits: 1000, referenceWhiteNits: 203, whiteQuantile: 0.995 },
            strengths: { luma: 1, chroma: 1, sharpen: 1, defringe: 1 },
          }),
        });
        return 'resolved';
      } catch (error) {
        return String(error);
      }
    });
    expect(reply).toContain('could not read');
  });
});
