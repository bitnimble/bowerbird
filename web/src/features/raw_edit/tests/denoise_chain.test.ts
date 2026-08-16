import { describe, expect, test } from 'bun:test';
import { buildDenoiseChain, type DenoiseAmounts, type DenoiseChain } from '../gpu/denoise_chain';

// WebGPU's usage flags are browser globals, and the chain names them while describing buffers.
// The values are never read here - nothing allocates - but they have to exist to be OR'd.
Object.assign(globalThis, {
  GPUBufferUsage: { STORAGE: 128, UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1 },
  GPUShaderStage: { COMPUTE: 4 },
});

// A device that records which pipelines were dispatched, and nothing else. The chain's shape is
// what is under test - which passes run for which amounts - and that is decided before any of it
// reaches a driver, so a real adapter would only make this slower and unavailable in `bun test`.
function recordingDevice(): { device: GPUDevice; dispatched: string[]; pushes: ArrayBuffer[] } {
  const dispatched: string[] = [];
  const named = new Map<object, string>();
  const pushes: ArrayBuffer[] = [];

  const device = {
    createShaderModule: ({ code }: { code: string }) => ({ code }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: () => ({ destroy() {} }),
    createComputePipeline: ({ compute }: { compute: { entryPoint: string } }) => {
      const pipeline = {};
      named.set(pipeline, compute.entryPoint);
      return pipeline;
    },
    queue: {
      writeBuffer(_buffer: unknown, _offset: number, data: ArrayBuffer) {
        // Only the pushes are ever written more than once; the noise constants land at build.
        if (data.byteLength > 32 * 4) pushes.push(data.slice(0));
      },
    },
    limits: { maxComputeWorkgroupsPerDimension: 65535 },
  } as unknown as GPUDevice;

  (device as unknown as { __named: Map<object, string> }).__named = named;
  return { device, dispatched, pushes };
}

function recordingEncoder(device: GPUDevice, dispatched: string[]): GPUCommandEncoder {
  const named = (device as unknown as { __named: Map<object, string> }).__named;
  return {
    beginComputePass: () => {
      let current = '';
      return {
        setPipeline: (pipeline: object) => {
          current = named.get(pipeline) ?? 'unknown';
        },
        setBindGroup() {},
        dispatchWorkgroups: () => dispatched.push(current),
        end() {},
      };
    },
  } as unknown as GPUCommandEncoder;
}

const WIDTH = 64;

function chainFor(device: GPUDevice, height = 64) {
  const buffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE });
  return buildDenoiseChain(device, buffer, buffer, WIDTH, height, {
    stabilised: 1,
    alpha: 0.5,
    sigmaSq: 0.01,
  });
}

/** Every band of one sweep, in order, which is the only order they may be recorded in. */
function sweep(chain: DenoiseChain, encoder: GPUCommandEncoder, amounts: DenoiseAmounts): void {
  for (let band = 0; band < chain.bands; band++) {
    chain.record(encoder, amounts, band);
  }
}

/** One band's pushes, by the slot each dispatch reads. */
function slotsOf(bytes: ArrayBuffer) {
  const ints = new Int32Array(bytes);
  const at = (slot: number) => (slot * 256) / 4;
  return {
    flat: [ints[at(0) + 1], ints[at(0)]] as const,
    tileRow: ints[at(3) + 3],
    loessRow: ints[at(6) + 5],
    pairs: [ints[at(7) + 1] * 2, ints[at(7)]] as const,
  };
}

describe('the denoise chain', () => {
  test('runs every pass the first time, whatever the amounts', () => {
    const { device, dispatched } = recordingDevice();
    const chain = chainFor(device);

    chain.record(recordingEncoder(device, dispatched), { luma: 0.5, blend: 0.2, ridge: 0.1 }, 0);

    expect(dispatched[0]).toBe('yuv_split');
    expect(dispatched).toContain('pass12');
    expect(dispatched.at(-1)).toBe('yuv_join');
  });

  test('resumes at the regression when only the colour amounts moved', () => {
    const { device, dispatched } = recordingDevice();
    const chain = chainFor(device);
    const encoder = recordingEncoder(device, dispatched);

    sweep(chain, encoder, { luma: 0.5, blend: 0.2, ridge: 0.1 });
    const whole = dispatched.length;
    dispatched.length = 0;

    sweep(chain, encoder, { luma: 0.5, blend: 0.9, ridge: 0.7 });

    // The regression and the join, and nothing before them: the planes they read still hold this
    // frame's luma, which is the whole reason a colour tick can be interactive.
    expect(dispatched).toEqual(['yuv_loess', 'yuv_join']);
    expect(dispatched.length).toBeLessThan(whole);
  });

  test('runs the whole chain again when the luma amount moved', () => {
    const { device, dispatched } = recordingDevice();
    const chain = chainFor(device);
    const encoder = recordingEncoder(device, dispatched);

    sweep(chain, encoder, { luma: 0.5, blend: 0.2, ridge: 0.1 });
    dispatched.length = 0;

    // The shrinkage is what `luma` feeds, so every plane below the regression is now stale.
    sweep(chain, encoder, { luma: 0.6, blend: 0.2, ridge: 0.1 });

    expect(dispatched[0]).toBe('yuv_split');
    expect(dispatched).toContain('pass12');
  });

  test('owes the luma again when a sweep was abandoned part way', () => {
    const { device, dispatched } = recordingDevice();
    const chain = chainFor(device, 300);
    const encoder = recordingEncoder(device, dispatched);
    expect(chain.bands).toBeGreaterThan(1);

    chain.record(encoder, { luma: 0.5, blend: 0.2, ridge: 0.1 }, 0);
    dispatched.length = 0;

    // The bands below the first still hold whatever the last finished sweep left them, so a
    // colour-only resume would regress rows that were never shrunk at this amount.
    sweep(chain, encoder, { luma: 0.5, blend: 0.9, ridge: 0.7 });

    expect(dispatched).toContain('pass12');
  });
});

describe("a sweep's bands", () => {
  const HEIGHT = 300;

  test('tile the frame exactly, and build the inverse table once between them', () => {
    const { device, dispatched, pushes } = recordingDevice();
    const chain = chainFor(device, HEIGHT);
    sweep(chain, recordingEncoder(device, dispatched), { luma: 0.5, blend: 0.2, ridge: 0.1 });

    expect(dispatched.filter((pass) => pass === 'build_inv_lut')).toHaveLength(1);
    expect(dispatched.filter((pass) => pass === 'lut_finalize')).toHaveLength(1);

    const bands = pushes.map(slotsOf);
    expect(bands).toHaveLength(chain.bands);

    // The pack writes two pixels a word, so a band that started mid-pair would have two of them
    // racing for one word - and one that left a gap would leave a strip of the frame undenoised.
    let pair = 0;
    let tileRow = 0;
    let loessRow = 0;
    for (const band of bands) {
      expect(band.pairs[0]).toBe(pair);
      expect(band.tileRow).toBe(tileRow);
      expect(band.loessRow).toBe(loessRow);
      pair = band.pairs[1];
      tileRow += 4;
      loessRow += 112;
    }
    expect(pair).toBe(WIDTH * HEIGHT);
  });

  test("scale each flat pass once over its own rows and the next band's halo", () => {
    const { device, dispatched, pushes } = recordingDevice();
    const chain = chainFor(device, HEIGHT);
    sweep(chain, recordingEncoder(device, dispatched), { luma: 0.5, blend: 0.2, ridge: 0.1 });

    // `yuv_sigma_norm` divides in place, so a row covered by two bands' neighbourhoods would be
    // scaled twice and the shrinkage would threshold it against a sigma it is no longer in.
    let prepared = 0;
    for (const band of pushes.map(slotsOf)) {
      expect(band.flat[0]).toBe(prepared);
      expect(band.flat[1]).toBeGreaterThan(prepared);
      prepared = band.flat[1];
    }
    expect(prepared).toBe(WIDTH * HEIGHT);
  });
});
