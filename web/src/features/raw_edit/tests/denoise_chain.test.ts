import { describe, expect, test } from 'bun:test';
import { buildDenoiseChain } from '../gpu/denoise_chain';

// WebGPU's usage flags are browser globals, and the chain names them while describing buffers.
// The values are never read here - nothing allocates - but they have to exist to be OR'd.
Object.assign(globalThis, {
  GPUBufferUsage: { STORAGE: 128, UNIFORM: 64, COPY_DST: 8, COPY_SRC: 4, MAP_READ: 1 },
  GPUShaderStage: { COMPUTE: 4 },
});

// A device that records which pipelines were dispatched, and nothing else. The chain's shape is
// what is under test - which passes run for which amounts - and that is decided before any of it
// reaches a driver, so a real adapter would only make this slower and unavailable in `bun test`.
function recordingDevice(): { device: GPUDevice; dispatched: string[] } {
  const dispatched: string[] = [];
  const named = new Map<object, string>();

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
    queue: { writeBuffer() {} },
    limits: { maxComputeWorkgroupsPerDimension: 65535 },
  } as unknown as GPUDevice;

  (device as unknown as { __dispatched: string[] }).__dispatched = dispatched;
  (device as unknown as { __named: Map<object, string> }).__named = named;
  return { device, dispatched };
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

function chainFor(device: GPUDevice) {
  const buffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE });
  return buildDenoiseChain(device, buffer, buffer, 64, 64, {
    stabilised: 1,
    alpha: 0.5,
    sigmaSq: 0.01,
  });
}

describe('the denoise chain', () => {
  test('runs every pass the first time, whatever the amounts', () => {
    const { device, dispatched } = recordingDevice();
    const chain = chainFor(device);

    chain.record(recordingEncoder(device, dispatched), { luma: 0.5, blend: 0.2, ridge: 0.1 });

    expect(dispatched[0]).toBe('yuv_split');
    expect(dispatched).toContain('pass12');
    expect(dispatched.at(-1)).toBe('yuv_join');
  });

  test('resumes at the regression when only the colour amounts moved', () => {
    const { device, dispatched } = recordingDevice();
    const chain = chainFor(device);
    const encoder = recordingEncoder(device, dispatched);

    chain.record(encoder, { luma: 0.5, blend: 0.2, ridge: 0.1 });
    const whole = dispatched.length;
    dispatched.length = 0;

    chain.record(encoder, { luma: 0.5, blend: 0.9, ridge: 0.7 });

    // The regression and the join, and nothing before them: the planes they read still hold this
    // frame's luma, which is the whole reason a colour tick can be interactive.
    expect(dispatched).toEqual(['yuv_loess', 'yuv_join']);
    expect(dispatched.length).toBeLessThan(whole);
  });

  test('runs the whole chain again when the luma amount moved', () => {
    const { device, dispatched } = recordingDevice();
    const chain = chainFor(device);
    const encoder = recordingEncoder(device, dispatched);

    chain.record(encoder, { luma: 0.5, blend: 0.2, ridge: 0.1 });
    dispatched.length = 0;

    // The shrinkage is what `luma` feeds, so every plane below the regression is now stale.
    chain.record(encoder, { luma: 0.6, blend: 0.2, ridge: 0.1 });

    expect(dispatched[0]).toBe('yuv_split');
    expect(dispatched).toContain('pass12');
  });
});
