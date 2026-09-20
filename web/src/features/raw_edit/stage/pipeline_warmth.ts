import { z } from 'zod';

const BindGroupLayoutSchema = z.custom<GPUBindGroupLayoutDescriptor>(
  (value) => typeof value === 'object' && value != null && 'entries' in value && Array.isArray(value.entries),
);

const PipelineRecipeSchema = z.object({
  code: z.string(),
  entryPoint: z.string().optional(),
  constants: z.record(z.string(), z.number()).optional(),
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

const KEPT_FOR_SESSIONS = 3;
const SAVE_QUIET_MS = 2000;

/**
 * Compiles, with `createComputePipelineAsync`, the pipelines recent sessions dispatched, before the
 * device reaches wgpu - whose own pipeline creation is synchronous on Chrome's GPU main thread and
 * freezes every frame the page draws, unless Chrome already holds an identical pipeline - and
 * defers each of wgpu's own to its first dispatch.
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

  install(adapter: GPUAdapter, device: GPUDevice, pass: GPUComputePassEncoder): void {
    const { createShaderModule, createBindGroupLayout, createPipelineLayout } = device;
    const { createComputePipeline, createComputePipelineAsync } = device;
    const { requestDevice } = adapter;
    const { setPipeline } = pass;
    const created = { createShaderModule, createBindGroupLayout, createPipelineLayout, createComputePipelineAsync };
    const { modules, groups, layouts } = this;
    const deferred = new WeakMap<
      object,
      { device: GPUDevice; descriptor: GPUComputePipelineDescriptor; pipeline?: GPUComputePipeline }
    >();
    const built = (descriptor: GPUComputePipelineDescriptor): void => this.built(descriptor);
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
    // wgpu only ever hands a compute pipeline back to `setPipeline`, so it can hold a stand-in
    // until then, and a variant this photograph never dispatches is never compiled.
    device.createComputePipeline = function (this: GPUDevice, descriptor) {
      const standIn = {} as GPUComputePipeline;
      deferred.set(standIn, { device: this, descriptor });
      return standIn;
    };
    pass.setPipeline = function (this: GPUComputePassEncoder, standIn) {
      const held = deferred.get(standIn);
      if (held == null) return setPipeline.call(this, standIn);
      if (held.pipeline == null) {
        held.pipeline = createComputePipeline.call(held.device, held.descriptor);
        built(held.descriptor);
      }
      return setPipeline.call(this, held.pipeline);
    };
    adapter.requestDevice = async function (this: GPUAdapter, descriptor) {
      const opened = await requestDevice.call(this, descriptor);
      await warm(opened);
      return opened;
    };
  }

  private built(descriptor: GPUComputePipelineDescriptor): void {
    if (descriptor.layout === 'auto') return;
    const code = this.modules.get(descriptor.compute.module);
    const groups = this.layouts.get(descriptor.layout);
    if (code == null || groups == null) return;
    const recipe: PipelineRecipe = {
      code,
      entryPoint: descriptor.compute.entryPoint,
      constants: descriptor.compute.constants == null ? undefined : { ...descriptor.compute.constants },
      groups,
      lastBuilt: this.session,
    };
    this.recipes.set(keyOf(recipe), recipe);
    if (this.saveTimer != null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_QUIET_MS);
  }

  private async warm(
    device: GPUDevice,
    created: Pick<
      GPUDevice,
      'createShaderModule' | 'createBindGroupLayout' | 'createPipelineLayout' | 'createComputePipelineAsync'
    >,
  ): Promise<void> {
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
      let module = modules.get(recipe.code);
      if (module == null) {
        module = created.createShaderModule.call(device, { code: recipe.code });
        modules.set(recipe.code, module);
        // Module parsing stays synchronous on the GPU main thread: a flush each, drawn between.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const layout = created.createPipelineLayout.call(device, {
        bindGroupLayouts: recipe.groups.map((group) =>
          group == null ? null : created.createBindGroupLayout.call(device, group),
        ),
      });
      compiling.push(
        created.createComputePipelineAsync.call(device, {
          layout,
          compute: { module, entryPoint: recipe.entryPoint, constants: recipe.constants },
        }),
      );
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

function keyOf({ code, entryPoint, constants, groups }: PipelineRecipe): string {
  return JSON.stringify([code, entryPoint, constants, groups]);
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
