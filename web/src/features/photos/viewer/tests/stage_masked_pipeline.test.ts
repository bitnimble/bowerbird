import { expect, test } from 'bun:test';
import { pipelinesFor } from '../stage_gpu';

// The flag constants are the platform's, not the types package's, so bun has none of them.
Object.defineProperty(globalThis, 'GPUBufferUsage', {
  value: { UNIFORM: 0x40, COPY_DST: 0x8 },
  configurable: true,
});

// `pipelinesFor` is a pure function of a device, so the one thing a masked draw depends on and no
// test with a real adapter is cheap enough to ask - that the two pipelines are distinct objects,
// over distinct fragment entry points - is answerable here. A bind group built against the wrong
// one of them is a validation failure nothing in `bun test` can see.
test('the masked pipeline is its own pipeline, over its own fragment entry point, and blended', () => {
  const fragments: { entryPoint: string; blended: boolean }[] = [];
  let made = 0;
  const device = {
    createShaderModule: () => ({}),
    createRenderPipeline: (desc: GPURenderPipelineDescriptor) => {
      const fragment = desc.fragment!;
      const [target] = [...fragment.targets];
      fragments.push({ entryPoint: fragment.entryPoint!, blended: target?.blend != null });
      return { id: made++ };
    },
    createBuffer: () => ({}),
    createSampler: () => ({}),
  } as unknown as GPUDevice;

  const drawing = pipelinesFor(device);
  expect(drawing.planar).not.toBe(drawing.planarMasked);
  expect(fragments).toContainEqual({ entryPoint: 'planar', blended: false });
  expect(fragments).toContainEqual({ entryPoint: 'planar_masked', blended: true });
});
