import { expect, test } from 'bun:test';
import { PipelineWarmth, type Recipes, type RecipeStore } from '../pipeline_warmth';

class Module {
  constructor(
    readonly label: string,
    readonly code: string,
  ) {}
}

class Layout {
  constructor(
    readonly label: string,
    readonly descriptor: GPUPipelineLayoutDescriptor,
  ) {}
}

/** Hands back tokens for what it is asked to create, and remembers what it compiled and how. */
class FakeDevice {
  static compiled: string[] = [];
  static compiledAsync: Record<string, unknown>[] = [];
  createShaderModule(descriptor: GPUShaderModuleDescriptor): unknown {
    return new Module(descriptor.label ?? '', descriptor.code);
  }
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): unknown {
    return { descriptor };
  }
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): unknown {
    return new Layout(descriptor.label ?? '', descriptor);
  }
  createComputePipeline(descriptor: GPUComputePipelineDescriptor): unknown {
    return FakeDevice.compile(descriptor.compute.module);
  }
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): unknown {
    return FakeDevice.compile(descriptor.vertex.module);
  }
  createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor): Promise<unknown> {
    return FakeDevice.compileAsync(descriptor, descriptor.compute.module);
  }
  createRenderPipelineAsync(descriptor: GPURenderPipelineDescriptor): Promise<unknown> {
    return FakeDevice.compileAsync(descriptor, descriptor.vertex.module);
  }
  pushErrorScope(): void {}
  popErrorScope(): Promise<null> {
    return Promise.resolve(null);
  }
  private static compile(module: GPUShaderModule): unknown {
    const { code } = module as unknown as Module;
    FakeDevice.compiled.push(code);
    return { compiled: code };
  }
  private static compileAsync(descriptor: object, module: GPUShaderModule): Promise<unknown> {
    FakeDevice.compiledAsync.push(descriptor as Record<string, unknown>);
    const { code } = module as unknown as Module;
    return new Promise((resolve) => setTimeout(() => resolve({ warmed: code }), 10));
  }
}

class FakePass {
  static set: unknown[] = [];
  setPipeline(pipeline: unknown): void {
    FakePass.set.push(pipeline);
  }
}

type Installed = {
  warmth: PipelineWarmth;
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
  const warmth = new PipelineWarmth(store);
  warmth.install({
    GPUAdapter: Adapter,
    GPUDevice: Device,
    GPUComputePassEncoder: Pass,
    GPURenderPassEncoder: Drawing,
    GPURenderBundleEncoder: Bundling,
  });
  return {
    warmth,
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

function layoutOf(device: GPUDevice, label: string, binding = 0): GPUPipelineLayout {
  const group = device.createBindGroupLayout({
    entries: [{ binding, visibility: 4, buffer: { type: 'storage' } }],
  });
  return device.createPipelineLayout({ label, bindGroupLayouts: [group] });
}

function build(device: GPUDevice, label: string, code: string, binding = 0): GPUComputePipeline {
  return device.createComputePipeline({
    layout: layoutOf(device, label, binding),
    compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main', constants: { 0: 1 } },
  });
}

function draw(device: GPUDevice, label: string, code: string): GPURenderPipeline {
  const module = device.createShaderModule({ label, code });
  return device.createRenderPipeline({
    layout: layoutOf(device, label),
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

function codeOf(warmed: Record<string, unknown> | undefined): string | undefined {
  return (warmed?.compute as { module: Module } | undefined)?.module.code;
}

/** A session that dispatches what `session` builds, and has saved its recipes by the end. */
async function dispatched(store: RecipeStore, session: (device: GPUDevice) => object): Promise<void> {
  const first = installed(store);
  first.pass.setPipeline(session(await first.adapter.requestDevice()) as GPUComputePipeline);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  reset();
}

test('a pipeline compiles at its first dispatch, once, and never if it is not dispatched', async () => {
  reset();
  const { adapter, pass } = installed(memory());
  const device = await adapter.requestDevice();
  const used = build(device, 'used', 'fn used() {}');
  build(device, 'unused', 'fn unused() {}');

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
  const sheet = draw(device, 'sheet', 'fn sheet() {}');
  const bundled = draw(device, 'bundled', 'fn bundled() {}');
  draw(device, 'never', 'fn never() {}');

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
  await dispatched(store, (device) => {
    build(device, 'never', 'fn never() {}');
    return build(device, 'a', 'fn a() {}');
  });

  await installed(store).adapter.requestDevice();
  expect(FakeDevice.compiledAsync).toHaveLength(1);
  const [warmed] = FakeDevice.compiledAsync;
  if (warmed == null) throw new Error('nothing was warmed');
  const compute = warmed.compute as { module: Module; entryPoint: string; constants: unknown };
  expect(compute.module.code).toBe('fn a() {}');
  expect(compute.entryPoint).toBe('main');
  expect(compute.constants).toEqual({ 0: 1 });
  const layout = warmed.layout as Layout;
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
  first.drawing.setPipeline(draw(device, 'sheet', 'fn sheet() {}'));
  await new Promise((resolve) => setTimeout(resolve, 2100));
  reset();

  await installed(store).adapter.requestDevice();
  const [warmed] = FakeDevice.compiledAsync;
  if (warmed == null) throw new Error('nothing was warmed');
  expect(warmed.primitive).toEqual({ topology: 'triangle-list' });
  const vertex = warmed.vertex as { module: Module; entryPoint: string };
  const fragment = warmed.fragment as { module: Module; targets: unknown };
  expect(vertex.entryPoint).toBe('vs');
  expect(fragment.targets).toEqual([{ format: 'rgba16float' }]);
  // One module for both stages, or the browser parses the same source twice on the GPU thread.
  expect(vertex.module).toBe(fragment.module);
});

test('a pipeline whose shader was edited since is warmed as it is created, and dispatched warm', async () => {
  reset();
  const store = memory();
  await dispatched(store, (device) => build(device, 'a', 'fn a() {}'));

  const next = installed(store);
  const device = await next.adapter.requestDevice();
  expect(FakeDevice.compiledAsync.map(codeOf)).toEqual(['fn a() {}']);
  const edited = build(device, 'a', 'fn a() { edited(); }');
  build(device, 'never', 'fn never() {}');
  expect(FakeDevice.compiledAsync.map(codeOf)).toEqual(['fn a() {}', 'fn a() { edited(); }']);

  await next.warmth.settled();
  next.pass.setPipeline(edited);
  expect(FakeDevice.compiled).toEqual([]);
  expect(FakePass.set).toEqual([{ warmed: 'fn a() { edited(); }' }]);
});

test('an unedited pipeline is dispatched as it was compiled before the device, and not compiled again', async () => {
  reset();
  const store = memory();
  await dispatched(store, (device) => build(device, 'a', 'fn a() {}'));

  const next = installed(store);
  const device = await next.adapter.requestDevice();
  next.pass.setPipeline(build(device, 'a', 'fn a() {}'));
  expect(FakeDevice.compiledAsync.map(codeOf)).toEqual(['fn a() {}']);
  expect(FakeDevice.compiled).toEqual([]);
  expect(FakePass.set).toEqual([{ warmed: 'fn a() {}' }]);
});

test('a pipeline whose bindings moved since is compiled against them, not handed the old one', async () => {
  reset();
  const store = memory();
  await dispatched(store, (device) => build(device, 'a', 'fn a() {}'));

  const next = installed(store);
  const device = await next.adapter.requestDevice();
  const moved = build(device, 'a', 'fn a() {}', 1);
  expect(FakeDevice.compiledAsync).toHaveLength(2);
  const [, live] = FakeDevice.compiledAsync;
  if (live == null) throw new Error('nothing was compiled against the moved bindings');
  await next.warmth.settled();
  next.pass.setPipeline(moved);
  expect(FakeDevice.compiled).toEqual([]);
  expect((live.layout as Layout).descriptor.bindGroupLayouts).toEqual([
    { descriptor: { entries: [{ binding: 1, visibility: 4, buffer: { type: 'storage' } }] } },
  ] as unknown as GPUBindGroupLayout[]);
});

test('unlabelled pipelines keep a recipe each', async () => {
  reset();
  const store = memory();
  const first = installed(store);
  const device = await first.adapter.requestDevice();
  first.pass.setPipeline(build(device, '', 'fn one() {}'));
  first.pass.setPipeline(build(device, '', 'fn two() {}'));
  await new Promise((resolve) => setTimeout(resolve, 2100));

  expect(store.kept?.recipes.map((recipe) => recipe.stages.compute)).toEqual(['fn one() {}', 'fn two() {}']);
});

test('a recipe no session has drawn with for a month is dropped', async () => {
  reset();
  const store = memory();
  await dispatched(store, (device) => build(device, 'a', 'fn a() {}'));
  const [recipe] = store.kept?.recipes ?? [];
  if (recipe == null) throw new Error('nothing was kept');
  store.kept = { recipes: [{ ...recipe, lastUsed: Date.now() - 31 * 24 * 60 * 60 * 1000 }] };

  await installed(store).adapter.requestDevice();
  expect(FakeDevice.compiledAsync).toEqual([]);
});

test('a pipeline created again later in the session is dispatched as its edited shader compiled', async () => {
  reset();
  const store = memory();
  await dispatched(store, (device) => build(device, 'a', 'fn a() {}'));

  const next = installed(store);
  const device = await next.adapter.requestDevice();
  next.pass.setPipeline(build(device, 'a', 'fn a() { edited(); }'));
  next.pass.setPipeline(build(device, 'a', 'fn a() { edited(); }'));
  expect(FakeDevice.compiled).toEqual(['fn a() { edited(); }']);
  expect(FakePass.set).toEqual([{ compiled: 'fn a() { edited(); }' }, { compiled: 'fn a() { edited(); }' }]);
});

test('an edited pipeline dispatched before its warming finishes compiles there, and replaces its recipe', async () => {
  reset();
  const store = memory();
  await dispatched(store, (device) => build(device, 'a', 'fn a() {}'));

  const next = installed(store);
  next.pass.setPipeline(build(await next.adapter.requestDevice(), 'a', 'fn a() { edited(); }'));
  expect(FakePass.set).toEqual([{ compiled: 'fn a() { edited(); }' }]);
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect(store.kept?.recipes.map((recipe) => recipe.stages)).toEqual([{ compute: 'fn a() { edited(); }' }]);
});
