// The upscaler's WGSL arms in Chromium's WebGPU, as a page would run them.
//
//   bun run scripts/upscale-bench-browser.ts <weights dir> time [repeats]
//   bun run scripts/upscale-bench-browser.ts <weights dir> check <mosaic.f32> <width> <height> <out dir>
//
// Needs `bun run build:wasm`. Serves the package and the weights to a blank page opened with the
// e2e suite's GPU flags. `time` prints each arm's milliseconds over a 24MP and a 61MP frame, the
// upload left out; `check` writes each arm's answer as `<out dir>/browser-<arm>.f32`, which
// `models/upscaler`'s `upscaler.device_check` holds against torch.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const ARMS: [boolean, number][] = [
  [true, 4],
  [true, 8],
  [false, 4],
  [false, 8],
];
const FRAMES: [string, number, number][] = [
  ['24MP', 6000, 4000],
  ['61MP', 9504, 6336],
];

/** `UpscaleTrial` as the package exports it, and what the page keeps of it between evaluations. */
interface Trial {
  run(): Promise<void>;
  answer(): Promise<Float32Array>;
  free(): void;
}
interface Held {
  rawshim: {
    UpscaleTrial: {
      open(
        manifest: string,
        weights: Uint8Array,
        mosaic: Float32Array,
        width: number,
        height: number,
        half: boolean,
        pixels: number,
      ): Promise<Trial>;
    };
  };
  manifest: string;
  weights: Uint8Array;
}
interface Adapter {
  info: { vendor: string; architecture: string; description: string };
  features: Set<string>;
}

const [weights, mode, ...rest] = process.argv.slice(2);
if (weights == null || (mode !== 'time' && mode !== 'check')) {
  console.error(
    'upscale-bench-browser <weights dir> time [repeats] | check <mosaic.f32> <width> <height> <out dir>',
  );
  process.exit(2);
}
const pkg = resolve(import.meta.dir, '..', 'native', 'rawshim', 'pkg');
const served: Record<string, string> = {
  '/weights.json': join(weights, 'weights.json'),
  '/weights.bin': join(weights, 'weights.bin'),
};
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/')
      return new Response('<!doctype html><title>upscale</title>', {
        headers: { 'content-type': 'text/html' },
      });
    const file = served[path] ?? (path.startsWith('/pkg/') ? join(pkg, path.slice(5)) : null);
    return file == null ? new Response(null, { status: 404 }) : new Response(Bun.file(file));
  },
});

const browser = await chromium.launch({
  args: [
    '--no-sandbox',
    '--enable-unsafe-webgpu',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
    '--ozone-platform=headless',
    ...(process.env.BOWERBIRD_CHROME_ARGS ?? '').split(' ').filter(Boolean),
  ],
});
try {
  const page = await browser.newPage();
  page.on('console', (message) => console.log(`page: ${message.text()}`));
  await page.goto(`http://localhost:${server.port}/`);
  const [adapter, f16] = await page.evaluate(async (): Promise<[string, boolean]> => {
    const gpu = (navigator as unknown as { gpu: { requestAdapter(): Promise<Adapter> } }).gpu;
    const adapter = await gpu.requestAdapter();
    const info = adapter.info;
    return [
      `${info.vendor} ${info.architecture} ${info.description}`,
      adapter.features.has('shader-f16'),
    ];
  });
  console.log(`adapter: ${adapter}, shader-f16 ${f16}`);
  const arms = ARMS.filter(([half]) => f16 || !half);
  await page.evaluate(async () => {
    const at: string = '/pkg/rawshim.js';
    const rawshim = await import(at);
    await rawshim.default();
    const held = globalThis as unknown as Held;
    held.rawshim = rawshim;
    held.manifest = await (await fetch('/weights.json')).text();
    held.weights = new Uint8Array(await (await fetch('/weights.bin')).arrayBuffer());
  });

  if (mode === 'time') {
    const repeats = Number(rest[0] ?? 5);
    for (const [name, width, height] of FRAMES) {
      for (const [half, pixels] of arms) {
        const times = await page.evaluate(
          async ({ width, height, half, pixels, repeats }) => {
            const held = globalThis as unknown as Held;
            const mosaic = new Float32Array(width * height);
            for (let i = 0; i < mosaic.length; i++)
              mosaic[i] = (Math.imul(i, 2654435761) >>> 8) / (1 << 24);
            const trial = await held.rawshim.UpscaleTrial.open(
              held.manifest,
              held.weights,
              mosaic,
              width,
              height,
              half,
              pixels,
            );
            await trial.run();
            await trial.run();
            const times: number[] = [];
            for (let r = 0; r < repeats; r++) {
              const start = performance.now();
              await trial.run();
              times.push(performance.now() - start);
            }
            trial.free();
            return times.sort((a, b) => a - b);
          },
          { width, height, half, pixels, repeats },
        );
        const arm = `${half ? 'half' : 'float'}-${pixels}`;
        const [best, median] = [times.at(0), times.at(times.length >> 1)];
        console.log(
          `${name} browser ${arm}: median ${median?.toFixed(1)}ms, best ${best?.toFixed(1)}ms`,
        );
      }
    }
  } else {
    const [input, width, height, out] = [rest[0], Number(rest[1]), Number(rest[2]), rest[3]];
    if (input == null || out == null) {
      console.error('check <mosaic.f32> <width> <height> <out dir>');
      process.exit(2);
    }
    mkdirSync(out, { recursive: true });
    const mosaic = Array.from(new Float32Array(readFileSync(input).buffer.slice(0)));
    for (const [half, pixels] of arms) {
      const answer: number[] = await page.evaluate(
        async ({ mosaic, width, height, half, pixels }) => {
          const held = globalThis as unknown as Held;
          const trial = await held.rawshim.UpscaleTrial.open(
            held.manifest,
            held.weights,
            new Float32Array(mosaic),
            width,
            height,
            half,
            pixels,
          );
          await trial.run();
          const answer = Array.from(await trial.answer());
          trial.free();
          return answer;
        },
        { mosaic, width, height, half, pixels },
      );
      const path = join(out, `browser-${half ? 'half' : 'float'}-${pixels}.f32`);
      writeFileSync(path, new Float32Array(answer));
      console.log(`wrote ${path}`);
    }
  }
} finally {
  await browser.close();
  server.stop();
}
