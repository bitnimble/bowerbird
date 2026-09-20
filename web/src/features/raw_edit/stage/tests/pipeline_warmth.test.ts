import { expect, test } from 'bun:test';
import { PipelineWarmth, type Recipes, type RecipeStore } from '../pipeline_warmth';

/** Hands back tokens for what it is asked to create, and remembers what it compiled and how. */
class FakeDevice {
  static compiled: string[] = [];
  static compiledAsync: GPUComputePipelineDescriptor[] = [];
  createShaderModule(descriptor: GPUShaderModuleDescriptor): unknown {
    return { code: descriptor.code };
  }
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): unknown {
    return { descriptor };
  }
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): unknown {
    return { descriptor };
  }
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): unknown {
    const { code } = descriptor.compute.module as unknown as { code: string };
    FakeDevice.compiled.push(code);
    return { compiled: code };
  }
  createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor): Promise<unknown> {
    FakeDevice.compiledAsync.push(descriptor);
    return Promise.resolve({});
  }
  pushErrorScope(): void {}
  popErrorScope(): Promise<null> {
    return Promise.resolve(null);
  }
}

class FakePass {
  static set: unknown[] = [];
  setPipeline(pipeline: unknown): void {
    FakePass.set.push(pipeline);
  }
}

/** Fresh classes per install, so each wraps prototypes no earlier install has wrapped. */
function installed(store: RecipeStore): { adapter: GPUAdapter; pass: GPUComputePassEncoder } {
  class Device extends FakeDevice {}
  class Pass extends FakePass {}
  class Adapter {
    requestDevice(): Promise<unknown> {
      return Promise.resolve(new Device());
    }
  }
  new PipelineWarmth(store).install(
    Adapter.prototype as unknown as GPUAdapter,
    Device.prototype as unknown as GPUDevice,
    Pass.prototype as unknown as GPUComputePassEncoder,
  );
  return {
    adapter: new Adapter() as unknown as GPUAdapter,
    pass: new Pass() as unknown as GPUComputePassEncoder,
  };
}

function memory(): RecipeStore & { kept: Recipes | null } {
  const store = {
    kept: null as Recipes | null,
    load: () => Promise.resolve(store.kept),
    save: (recipes: Recipes) => {
      store.kept = recipes;
      return Promise.resolve();
    },
  };
  return store;
}

function build(device: GPUDevice, code: string): GPUComputePipeline {
  const group = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
  });
  return device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [group] }),
    compute: { module: device.createShaderModule({ code }), entryPoint: 'main', constants: { 0: 1 } },
  });
}

function reset(): void {
  FakeDevice.compiled = [];
  FakeDevice.compiledAsync = [];
  FakePass.set = [];
}

test('a pipeline compiles at its first dispatch, once, and never if it is not dispatched', async () => {
  reset();
  const { adapter, pass } = installed(memory());
  const device = await adapter.requestDevice();
  const used = build(device, 'fn used() {}');
  build(device, 'fn unused() {}');

  expect(FakeDevice.compiled).toEqual([]);
  pass.setPipeline(used);
  pass.setPipeline(used);
  expect(FakeDevice.compiled).toEqual(['fn used() {}']);
  expect(FakePass.set).toEqual([{ compiled: 'fn used() {}' }, { compiled: 'fn used() {}' }]);
});

test('the next session compiles in the background what the last one dispatched', async () => {
  reset();
  const store = memory();
  const first = installed(store);
  const device = await first.adapter.requestDevice();
  first.pass.setPipeline(build(device, 'fn a() {}'));
  build(device, 'fn never() {}');
  await new Promise((resolve) => setTimeout(resolve, 2100));

  expect(FakeDevice.compiledAsync).toEqual([]);

  await installed(store).adapter.requestDevice();
  expect(FakeDevice.compiledAsync).toHaveLength(1);
  const [warmed] = FakeDevice.compiledAsync;
  if (warmed == null) throw new Error('nothing was warmed');
  expect((warmed.compute.module as unknown as { code: string }).code).toBe('fn a() {}');
  expect(warmed.compute.entryPoint).toBe('main');
  expect(warmed.compute.constants).toEqual({ 0: 1 });
  const layout = warmed.layout as unknown as { descriptor: GPUPipelineLayoutDescriptor };
  const [group] = [...layout.descriptor.bindGroupLayouts] as unknown as {
    descriptor: GPUBindGroupLayoutDescriptor;
  }[];
  expect(group?.descriptor).toEqual({
    entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
  });
});

test('a recipe no session has dispatched for three sessions is dropped', async () => {
  reset();
  const store = memory();
  store.kept = {
    session: 5,
    recipes: [
      { code: 'stale', groups: [], lastBuilt: 3 },
      { code: 'recent', groups: [], lastBuilt: 4 },
    ],
  };
  await installed(store).adapter.requestDevice();

  expect(
    FakeDevice.compiledAsync.map((d) => (d.compute.module as unknown as { code: string }).code),
  ).toEqual(['recent']);
});
