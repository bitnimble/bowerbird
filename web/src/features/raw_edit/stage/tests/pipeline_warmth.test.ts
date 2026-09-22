import { expect, test } from 'bun:test';
import { PipelineWarmth, type Recipes, type RecipeStore } from '../pipeline_warmth';

/** Hands back tokens for what it is asked to create, and remembers what it compiled and how. */
class FakeDevice {
  static compiled: string[] = [];
  static compiledAsync: Record<string, unknown>[] = [];
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
    return FakeDevice.compile(descriptor.compute.module);
  }
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): unknown {
    return FakeDevice.compile(descriptor.vertex.module);
  }
  createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor): Promise<unknown> {
    FakeDevice.compiledAsync.push(descriptor as unknown as Record<string, unknown>);
    return Promise.resolve({});
  }
  createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor): Promise<unknown> {
    FakeDevice.compiledAsync.push(descriptor as unknown as Record<string, unknown>);
    return Promise.resolve({});
  }
  pushErrorScope(): void {}
  popErrorScope(): Promise<null> {
    return Promise.resolve(null);
  }
  private static compile(module: GPUShaderModule): unknown {
    const { code } = module as unknown as { code: string };
    FakeDevice.compiled.push(code);
    return { compiled: code };
  }
}

class FakePass {
  static set: unknown[] = [];
  setPipeline(pipeline: unknown): void {
    FakePass.set.push(pipeline);
  }
}

type Scope = {
  GPUAdapter: unknown;
  GPUDevice: unknown;
  GPUComputePassEncoder: unknown;
  GPURenderPassEncoder: unknown;
  GPURenderBundleEncoder: unknown;
};

type Installed = {
  adapter: GPUAdapter;
  pass: GPUComputePassEncoder;
  drawing: GPURenderPassEncoder;
  bundling: GPURenderBundleEncoder;
};

/** Fresh classes per install, so each wraps prototypes no earlier install has wrapped. */
function installed(store: RecipeStore): Installed {
  class Device extends FakeDevice {}
  class Pass extends FakePass {}
  class Drawing extends FakePass {}
  class Bundling extends FakePass {}
  class Adapter {
    requestDevice(): Promise<unknown> {
      return Promise.resolve(new Device());
    }
  }
  const scope: Scope = {
    GPUAdapter: Adapter,
    GPUDevice: Device,
    GPUComputePassEncoder: Pass,
    GPURenderPassEncoder: Drawing,
    GPURenderBundleEncoder: Bundling,
  };
  new PipelineWarmth(store).install(scope);
  return {
    adapter: new Adapter() as unknown as GPUAdapter,
    pass: new Pass() as unknown as GPUComputePassEncoder,
    drawing: new Drawing() as unknown as GPURenderPassEncoder,
    bundling: new Bundling() as unknown as GPURenderBundleEncoder,
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

function layoutOf(device: GPUDevice): GPUPipelineLayout {
  const group = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
  });
  return device.createPipelineLayout({ bindGroupLayouts: [group] });
}

function build(device: GPUDevice, code: string): GPUComputePipeline {
  return device.createComputePipeline({
    layout: layoutOf(device),
    compute: { module: device.createShaderModule({ code }), entryPoint: 'main', constants: { 0: 1 } },
  });
}

function draw(device: GPUDevice, code: string): GPURenderPipeline {
  const module = device.createShaderModule({ code });
  return device.createRenderPipeline({
    layout: layoutOf(device),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
    primitive: { topology: 'triangle-list' },
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

test('every pass that takes a pipeline waits for it, drawn or bundled as well as dispatched', async () => {
  reset();
  const { adapter, drawing, bundling } = installed(memory());
  const device = await adapter.requestDevice();
  const sheet = draw(device, 'fn sheet() {}');
  const bundled = draw(device, 'fn bundled() {}');
  draw(device, 'fn never() {}');

  expect(FakeDevice.compiled).toEqual([]);
  drawing.setPipeline(sheet);
  bundling.setPipeline(bundled);
  expect(FakeDevice.compiled).toEqual(['fn sheet() {}', 'fn bundled() {}']);
});

test('a pipeline laid out automatically is built as it is asked for, so its layout can be read back', async () => {
  reset();
  const { adapter } = installed(memory());
  const device = await adapter.requestDevice();
  device.createComputePipeline({
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: 'fn loose() {}' }), entryPoint: 'main' },
  });

  expect(FakeDevice.compiled).toEqual(['fn loose() {}']);
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
  const compute = warmed.compute as { module: { code: string }; entryPoint: string; constants: unknown };
  expect(compute.module.code).toBe('fn a() {}');
  expect(compute.entryPoint).toBe('main');
  expect(compute.constants).toEqual({ 0: 1 });
  const layout = warmed.layout as { descriptor: GPUPipelineLayoutDescriptor };
  const [group] = [...layout.descriptor.bindGroupLayouts] as unknown as {
    descriptor: GPUBindGroupLayoutDescriptor;
  }[];
  expect(group?.descriptor).toEqual({
    entries: [{ binding: 0, visibility: 4, buffer: { type: 'storage' } }],
  });
});

test('a warmed draw goes to the drawing builder with the targets and primitive it had', async () => {
  reset();
  const store = memory();
  const first = installed(store);
  const device = await first.adapter.requestDevice();
  first.drawing.setPipeline(draw(device, 'fn sheet() {}'));
  await new Promise((resolve) => setTimeout(resolve, 2100));

  await installed(store).adapter.requestDevice();
  const [warmed] = FakeDevice.compiledAsync;
  if (warmed == null) throw new Error('nothing was warmed');
  expect(warmed.primitive).toEqual({ topology: 'triangle-list' });
  const vertex = warmed.vertex as { module: { code: string }; entryPoint: string };
  const fragment = warmed.fragment as { module: { code: string }; targets: unknown };
  expect(vertex.entryPoint).toBe('vs');
  expect(fragment.targets).toEqual([{ format: 'rgba16float' }]);
  // One module for both stages, or the browser parses the same source twice on the GPU thread.
  expect(vertex.module).toBe(fragment.module);
});

test('a recipe no session has dispatched for three sessions is dropped', async () => {
  reset();
  const store = memory();
  store.kept = {
    session: 5,
    recipes: [
      { build: 'createComputePipeline', descriptor: {}, stages: { compute: 'stale' }, groups: [], lastBuilt: 3 },
      { build: 'createComputePipeline', descriptor: {}, stages: { compute: 'recent' }, groups: [], lastBuilt: 4 },
    ],
  };
  await installed(store).adapter.requestDevice();

  expect(
    FakeDevice.compiledAsync.map((d) => (d.compute as { module: { code: string } }).module.code),
  ).toEqual(['recent']);
});
