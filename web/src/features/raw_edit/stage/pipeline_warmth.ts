import { z } from 'zod';

const BindGroupLayoutSchema = z.custom<GPUBindGroupLayoutDescriptor>(
  (value) => typeof value === 'object' && value != null && 'entries' in value && Array.isArray(value.entries),
);

const PipelineRecipeSchema = z.object({
  /** The `GPUDevice` method that built it, whose `…Async` twin is what warms it. */
  build: z.string(),
  /** The descriptor less its layout and its modules, which are objects rather than data. */
  descriptor: z.record(z.string(), z.unknown()),
  /** The code of each stage's module, by the descriptor field it sat in. */
  stages: z.record(z.string(), z.string()),
  groups: z.array(BindGroupLayoutSchema.nullable()),
  lastBuilt: z.number(),
});
export type PipelineRecipe = z.infer<typeof PipelineRecipeSchema>;

const RecipesSchema = z.object({ session: z.number(), recipes: z.array(PipelineRecipeSchema) });
export type Recipes = z.infer<typeof RecipesSchema>;

export type RecipeStore = {
  load: () => Promise<Recipes | null>;
  save: (recipes: Recipes) => Promise<void>;
};

type PipelineDescriptor = { layout: GPUPipelineLayout | GPUAutoLayoutMode };
type Build = (this: GPUDevice, descriptor: PipelineDescriptor) => object;
type BuildAsync = (this: GPUDevice, descriptor: PipelineDescriptor) => Promise<object>;
type Builder = GPUDevice & Record<string, Build | BuildAsync>;
type Setter = { setPipeline: (pipeline: object) => void };
type Class<T> = { prototype: T };

type Created = Pick<GPUDevice, 'createShaderModule' | 'createBindGroupLayout' | 'createPipelineLayout'>;

const BUILDS = /^create\w*Pipeline$/;
const KEPT_FOR_SESSIONS = 3;
const SAVE_QUIET_MS = 2000;

/**
 * Compiles, asynchronously, the pipelines recent sessions drew with, before the device reaches
 * wgpu - whose own pipeline creation is synchronous on the browser's GPU main thread, where it
 * blocks every page being drawn until it returns - and defers each of wgpu's own to its first use.
 *
 * It finds its surface rather than being told it, so a pipeline nobody here has heard of is
 * covered on the day it is written: every `create…Pipeline` on `GPUDevice` is deferred, every
 * `GPU…` class that takes one through `setPipeline` unwraps it, and the recipe names the method
 * that built it so the warm-up can call that method's `…Async` twin.
 */
export class PipelineWarmth {
  private readonly modules = new WeakMap<GPUShaderModule, string>();
  private readonly groups = new WeakMap<GPUBindGroupLayout, GPUBindGroupLayoutDescriptor>();
  private readonly layouts = new WeakMap<
    GPUPipelineLayout,
    (GPUBindGroupLayoutDescriptor | null)[]
  >();
  private readonly recipes = new Map<string, PipelineRecipe>();
  private session = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly store: RecipeStore) {}

  /** The global scope the WebGPU classes live on, which is `self` outside a test. */
  install(scope: object): void {
    const devices = classIn<Builder>(scope, 'GPUDevice');
    const adapters = classIn<GPUAdapter>(scope, 'GPUAdapter');
    if (devices == null || adapters == null) return;
    const device = devices.prototype;
    const adapter = adapters.prototype;
    const { createShaderModule, createBindGroupLayout, createPipelineLayout } = device;
    const { requestDevice } = adapter;
    const created: Created = { createShaderModule, createBindGroupLayout, createPipelineLayout };
    const { modules, groups, layouts } = this;
    const deferred = new WeakMap<object, { build: () => object; pipeline?: object }>();
    const built = (build: string, descriptor: PipelineDescriptor): void => this.built(build, descriptor);
    const warm = (opened: GPUDevice): Promise<void> => this.warm(opened, created);

    device.createShaderModule = function (this: GPUDevice, descriptor) {
      const module = createShaderModule.call(this, descriptor);
      modules.set(module, descriptor.code);
      return module;
    };
    device.createBindGroupLayout = function (this: GPUDevice, descriptor) {
      const layout = createBindGroupLayout.call(this, descriptor);
      groups.set(layout, JSON.parse(JSON.stringify(descriptor)));
      return layout;
    };
    device.createPipelineLayout = function (this: GPUDevice, descriptor) {
      const layout = createPipelineLayout.call(this, descriptor);
      layouts.set(
        layout,
        [...descriptor.bindGroupLayouts].map((group) => (group == null ? null : (groups.get(group) ?? null))),
      );
      return layout;
    };
    // wgpu only ever hands a pipeline back to `setPipeline`, so it can hold a stand-in until then,
    // and a variant this photograph never draws with is never compiled. A pipeline laid out
    // automatically is the exception: its layout is read back off the object itself.
    for (const name of methodsOf(device).filter((name) => BUILDS.test(name))) {
      const build = device[name] as Build;
      device[name] = function (this: GPUDevice, descriptor: PipelineDescriptor) {
        if (descriptor.layout === 'auto') return build.call(this, descriptor);
        const standIn = {};
        deferred.set(standIn, {
          build: () => {
            const pipeline = build.call(this, descriptor);
            built(name, descriptor);
            return pipeline;
          },
        });
        return standIn;
      };
    }
    for (const pass of settersIn(scope)) {
      const { setPipeline } = pass.prototype;
      pass.prototype.setPipeline = function (this: Setter, standIn: object) {
        const wait = deferred.get(standIn);
        if (wait == null) return setPipeline.call(this, standIn);
        wait.pipeline ??= wait.build();
        return setPipeline.call(this, wait.pipeline);
      };
    }
    adapter.requestDevice = async function (this: GPUAdapter, descriptor) {
      const opened = await requestDevice.call(this, descriptor);
      await warm(opened);
      return opened;
    };
  }

  private built(build: string, descriptor: PipelineDescriptor): void {
    if (descriptor.layout === 'auto') return;
    const groups = this.layouts.get(descriptor.layout);
    if (groups == null) return;
    const stages: Record<string, string> = {};
    const kept: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(descriptor)) {
      if (field === 'layout') continue;
      const stage = value as { module?: GPUShaderModule } | null;
      if (stage?.module == null) {
        kept[field] = JSON.parse(JSON.stringify(value));
        continue;
      }
      const code = this.modules.get(stage.module);
      if (code == null) return;
      stages[field] = code;
      kept[field] = JSON.parse(JSON.stringify({ ...stage, module: undefined }));
    }
    const recipe: PipelineRecipe = { build, descriptor: kept, stages, groups, lastBuilt: this.session };
    this.recipes.set(keyOf(recipe), recipe);
    if (this.saveTimer != null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_QUIET_MS);
  }

  private async warm(device: GPUDevice, created: Created): Promise<void> {
    const stored = await this.store.load().catch(() => null);
    this.session = (stored?.session ?? 0) + 1;
    for (const recipe of stored?.recipes ?? []) {
      if (recipe.lastBuilt > this.session - KEPT_FOR_SESSIONS) this.recipes.set(keyOf(recipe), recipe);
    }
    if (this.recipes.size === 0) return;

    // Scoped: a stale recipe's refusal would otherwise reach the module's handler and fail the editor.
    device.pushErrorScope('validation');
    const modules = new Map<string, GPUShaderModule>();
    const compiling: Promise<unknown>[] = [];
    for (const recipe of this.recipes.values()) {
      const build = (device as Builder)[`${recipe.build}Async`] as BuildAsync | undefined;
      if (build == null) continue;
      const descriptor: Record<string, unknown> = { ...recipe.descriptor };
      for (const [field, code] of Object.entries(recipe.stages)) {
        let module = modules.get(code);
        if (module == null) {
          module = created.createShaderModule.call(device, { code });
          modules.set(code, module);
          // Module parsing stays synchronous on the GPU main thread: a flush each, drawn between.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        descriptor[field] = { ...(recipe.descriptor[field] as object | undefined), module };
      }
      descriptor.layout = created.createPipelineLayout.call(device, {
        bindGroupLayouts: recipe.groups.map((group) =>
          group == null ? null : created.createBindGroupLayout.call(device, group),
        ),
      });
      compiling.push(build.call(device, descriptor as unknown as PipelineDescriptor));
    }
    const refused = device.popErrorScope();
    await Promise.allSettled([refused, ...compiling]);
  }

  private async save(): Promise<void> {
    this.saveTimer = null;
    await this.store
      .save({ session: this.session, recipes: [...this.recipes.values()] })
      .catch(() => undefined);
  }
}

function methodsOf(prototype: object): string[] {
  const names = new Set<string>();
  for (let held: object | null = prototype; held != null && held !== Object.prototype; ) {
    for (const name of Object.getOwnPropertyNames(held)) names.add(name);
    held = Object.getPrototypeOf(held) as object | null;
  }
  return [...names];
}

function classIn<T>(scope: object, name: string): Class<T> | null {
  const held = (scope as Record<string, unknown>)[name];
  return typeof held === 'function' ? (held as unknown as Class<T>) : null;
}

/** Every WebGPU class in the scope that takes a pipeline, found rather than listed. */
function settersIn(scope: object): Class<Setter>[] {
  return Object.getOwnPropertyNames(scope)
    .filter((name) => name.startsWith('GPU'))
    .map((name) => classIn<Setter>(scope, name))
    .filter((held): held is Class<Setter> => typeof held?.prototype.setPipeline === 'function');
}

function keyOf({ build, descriptor, stages, groups }: PipelineRecipe): string {
  return JSON.stringify([build, descriptor, stages, groups]);
}

export function cachedRecipes(): RecipeStore {
  const key = new Request(new URL('/pipeline-recipes.json', self.location.origin));
  const open = (): Promise<Cache> => caches.open('bowerbird-pipelines');
  return {
    load: async () => {
      const kept = await (await open()).match(key);
      if (kept == null) return null;
      // Written by whichever build ran last, so a shape this one cannot read is a cache to rebuild.
      const recipes = RecipesSchema.safeParse(await kept.json());
      return recipes.success ? recipes.data : null;
    },
    save: async (recipes) => {
      await (await open()).put(key, new Response(JSON.stringify(recipes)));
    },
  };
}
