import { z } from 'zod';
import { safeJson, type DeviceFiles } from '../../../app/local_setting';
import { Logger } from '../../logs/page_log';

const log = new Logger('pipelines');

const BindGroupLayoutSchema = z.custom<GPUBindGroupLayoutDescriptor>(
  (value) =>
    typeof value === 'object' &&
    value != null &&
    'entries' in value &&
    Array.isArray(value.entries),
);

const PipelineRecipeSchema = z.object({
  /** The pipeline as it is recognised after an edit to its shaders (`PipelineWarmth.identityOf`). */
  identity: z.string(),
  /** The `GPUDevice` method that built it, whose `…Async` twin is what warms it. */
  build: z.string(),
  /** The descriptor less its layout and its modules, which are objects rather than data. */
  descriptor: z.record(z.string(), z.unknown()),
  /** The code of each stage's module, by the descriptor field it sat in. */
  stages: z.record(z.string(), z.string()),
  groups: z.array(BindGroupLayoutSchema),
  /** When a session last drew with it or precompiled it, in milliseconds since the epoch. */
  lastUsed: z.number(),
  /** When a session last drew with it, which is what earns it a place in the warm-up. */
  lastDrawn: z.number().nullable().default(null),
});
export type PipelineRecipe = z.infer<typeof PipelineRecipeSchema>;

const RecipesSchema = z.object({ recipes: z.array(PipelineRecipeSchema) });
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
type Deferred = {
  recipe: PipelineRecipe;
  build: () => object;
  compile: () => Promise<object>;
  pipeline?: object;
  warmed?: object;
};

type Created = Pick<
  GPUDevice,
  'createShaderModule' | 'createBindGroupLayout' | 'createPipelineLayout'
>;

const BUILDS = /^create\w*Pipeline$/;
const SAVE_QUIET_MS = 2000;
const KEPT_UNUSED_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Compiles, asynchronously, the pipelines earlier sessions drew with, and hands each to the stand-in
 * wgpu creates in its place - wgpu's own pipeline creation being synchronous on the browser's GPU
 * main thread, where it blocks every page being drawn until it returns - deferring the rest to
 * their first use. Where it does not warm at open, nothing is warmed until `warmUp`, so a session
 * that never edits compiles nothing.
 *
 * It finds its surface rather than being told it, so a pipeline nobody here has heard of is
 * covered on the day it is written: every `create…Pipeline` on `GPUDevice` is deferred, every
 * `GPU…` class that takes one through `setPipeline` unwraps it, and the recipe names the method
 * that built it so the warm-up can call that method's `…Async` twin.
 */
export class PipelineWarmth {
  private readonly modules = new WeakMap<GPUShaderModule, string>();
  private readonly groups = new WeakMap<GPUBindGroupLayout, GPUBindGroupLayoutDescriptor>();
  private readonly layouts = new WeakMap<GPUPipelineLayout, GPUBindGroupLayoutDescriptor[]>();
  private readonly recipes = new Map<string, PipelineRecipe>();
  /** A pipeline compiled from each recipe as it stands, for the next stand-in built from the same code. */
  private readonly compiled = new Map<string, object>();
  private readonly warming = new Set<Promise<unknown>>();
  private readonly handedOut = new Set<WeakRef<Deferred>>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opened = Date.now();
  private compiling = 0;
  private readonly waitingToCompile: (() => void)[] = [];
  private compilesAsked = 0;
  private compilesDone = 0;
  private readonly progressListeners = new Set<(compiled: number, of: number) => void>();
  private device: { opened: GPUDevice; created: Created } | null = null;
  private warmedUp: Promise<void> | null = null;
  private storedLoaded: Promise<boolean> | null = null;
  /** One until told otherwise: the start message arrives ahead of any compile. */
  private compilesAtOnce = 1;

  /**
   * @param compilesSparingly true to compile one at a time, and warm only what was drawn and only
   *   on `warmUp`; false to hand the device back once every remembered pipeline, precompiled or
   *   drawn, has compiled, all at once.
   */
  constructor(
    private readonly store: RecipeStore,
    private readonly compilesSparingly: Promise<boolean> = Promise.resolve(true),
  ) {
    void compilesSparingly.then((sparing) => {
      this.compilesAtOnce = sparing ? 1 : Infinity;
    });
  }

  /** Compiles, once, the remembered pipelines this warmth warms; nothing before a device has opened. */
  warmUp(): Promise<void> {
    if (this.device == null) return Promise.resolve();
    if (this.warmedUp == null) {
      this.warmedUp = this.warm(this.device.opened, this.device.created).catch((error: unknown) =>
        log.warn('could not warm the pipelines; each compiles at its first draw', error),
      );
      this.track(this.warmedUp);
    }
    return this.warmedUp;
  }

  /** Every compile this warmth has run in the background and how many it has been asked for, as either moves. */
  onProgress(listener: (compiled: number, of: number) => void): void {
    this.progressListeners.add(listener);
  }

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
    const { modules, groups, layouts, handedOut } = this;
    const deferred = new WeakMap<object, Deferred>();
    const recipeOf = (
      build: string,
      descriptor: PipelineDescriptor,
      layout: GPUPipelineLayout,
    ): PipelineRecipe => this.recipeOf(build, descriptor, layout);
    const arrived = (wait: Deferred): void => this.arrived(wait);
    const drawn = (wait: Deferred): object => this.drawn(wait);
    const opens = async (opened: GPUDevice): Promise<void> => {
      this.device = { opened, created };
      if (!(await this.compilesSparingly)) await this.warmUp();
    };

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
        [...descriptor.bindGroupLayouts].map((group) => recorded(groups, group)),
      );
      return layout;
    };
    // wgpu only ever hands a pipeline back to `setPipeline`, so it can hold a stand-in until then,
    // and a variant this photograph never draws with is never compiled. A pipeline laid out
    // automatically is the exception: its layout is read back off the object itself.
    for (const name of methodsOf(device).filter((name) => BUILDS.test(name))) {
      const build = device[name] as Build;
      const buildAsync = device[`${name}Async`] as BuildAsync;
      device[name] = function (this: GPUDevice, descriptor: PipelineDescriptor) {
        const { layout } = descriptor;
        if (layout === 'auto') return build.call(this, descriptor);
        const standIn = {};
        const wait: Deferred = {
          recipe: recipeOf(name, descriptor, layout),
          build: () => build.call(this, descriptor),
          compile: () => buildAsync.call(this, descriptor),
        };
        deferred.set(standIn, wait);
        handedOut.add(new WeakRef(wait));
        arrived(wait);
        return standIn;
      };
    }
    for (const pass of settersIn(scope)) {
      const { setPipeline } = pass.prototype;
      pass.prototype.setPipeline = function (this: Setter, standIn: object) {
        const wait = deferred.get(standIn);
        if (wait == null) return setPipeline.call(this, standIn);
        return setPipeline.call(this, wait.pipeline ?? drawn(wait));
      };
    }
    adapter.requestDevice = async function (this: GPUAdapter, descriptor) {
      const opened = await requestDevice.call(this, descriptor);
      await opens(opened);
      return opened;
    };
  }

  private drawn(wait: Deferred): object {
    wait.pipeline = this.warmedFor(wait) ?? wait.build();
    this.built(wait.recipe, wait.pipeline, true);
    return wait.pipeline;
  }

  /**
   * Warmed for the stand-in, or since from a recipe of the same code: the warm-up starts after
   * wgpu has handed most stand-ins out.
   */
  private warmedFor(wait: Deferred): object | undefined {
    const { identity } = wait.recipe;
    const kept = this.recipes.get(identity);
    return (
      wait.warmed ??
      (kept != null && sameRecipe(kept, wait.recipe) ? this.compiled.get(identity) : undefined)
    );
  }

  /** Resolves once every pipeline being warmed has compiled, so a draw finds it rather than compiling it. */
  async settled(): Promise<void> {
    while (this.warming.size > 0) await Promise.allSettled(this.warming);
  }

  /**
   * Compiles every pipeline `build` creates, and every one created before it and not yet drawn
   * with, keeping each as a recipe that later sessions warm. A pipeline the browser refuses still
   * counts as compiled (`onProgress`); its first use builds it and reports why.
   */
  async precompile(build: () => void): Promise<void> {
    build();
    await this.settled();
    for (const wait of this.undrawn()) {
      const warmed = this.warmedFor(wait);
      if (warmed != null) {
        this.built(wait.recipe, warmed, false);
        continue;
      }
      this.track(
        this.inTurn(wait.compile).then((pipeline) => {
          wait.warmed = pipeline;
          this.built(wait.recipe, pipeline, false);
        }),
      );
    }
    await this.settled();
    if (this.saveTimer != null) clearTimeout(this.saveTimer);
    await this.save();
  }

  private undrawn(): Deferred[] {
    const waits: Deferred[] = [];
    for (const held of this.handedOut) {
      const wait = held.deref();
      if (wait == null || wait.pipeline != null) this.handedOut.delete(held);
      else waits.push(wait);
    }
    return waits;
  }

  /**
   * Compiles a stand-in an earlier session drew with now where its shaders or layout have changed
   * since; one unchanged is handed the warm-up's pipeline when it is drawn.
   */
  private arrived(wait: Deferred): void {
    const { recipe } = wait;
    const kept = this.recipes.get(recipe.identity);
    if (kept == null || sameRecipe(kept, recipe)) return;
    this.track(
      this.inTurn(wait.compile).then((pipeline) => {
        wait.warmed = pipeline;
      }),
    );
  }

  private async inTurn<T>(compile: () => Promise<T>): Promise<T> {
    this.compilesAsked++;
    this.progressed();
    // Each compile holds the driver's compiler memory until it returns, and Android's WebView runs
    // them in the app's own process: all of the editor's at once aborted it out of memory.
    if (this.compiling < this.compilesAtOnce) this.compiling++;
    else await new Promise<void>((resolve) => this.waitingToCompile.push(resolve));
    try {
      return await compile();
    } finally {
      this.compilesDone++;
      this.progressed();
      // Handed over without freeing the slot, else a caller arriving in between takes it too.
      const next = this.waitingToCompile.shift();
      if (next == null) this.compiling--;
      else next();
    }
  }

  private progressed(): void {
    for (const listener of this.progressListeners) listener(this.compilesDone, this.compilesAsked);
  }

  private track(compiling: Promise<void>): void {
    const tracked = compiling
      // Refused here, the first use builds it synchronously and reports why through wgpu.
      .catch(() => undefined)
      .finally(() => this.warming.delete(tracked));
    this.warming.add(tracked);
  }

  private recipeOf(
    build: string,
    descriptor: PipelineDescriptor,
    layout: GPUPipelineLayout,
  ): PipelineRecipe {
    const stages: Record<string, string> = {};
    const kept: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(descriptor)) {
      if (field === 'layout') continue;
      const stage = value as { module?: GPUShaderModule } | null;
      if (stage?.module == null) {
        kept[field] = JSON.parse(JSON.stringify(value));
        continue;
      }
      stages[field] = recorded(this.modules, stage.module);
      kept[field] = JSON.parse(JSON.stringify({ ...stage, module: undefined }));
    }
    return {
      identity: this.identityOf(build, descriptor),
      build,
      descriptor: kept,
      stages,
      groups: recorded(this.layouts, layout),
      lastUsed: this.opened,
      lastDrawn: null,
    };
  }

  /**
   * Modules and layouts by label, not code, so a pipeline keeps its recipe across an edit to its
   * shader. One wgpu left unlabelled is named by its contents, or unlike pipelines would share a recipe.
   */
  private identityOf(build: string, descriptor: PipelineDescriptor): string {
    return JSON.stringify([build, descriptor], (_, value: unknown) => {
      if (
        !(value instanceof Object) ||
        Array.isArray(value) ||
        !('label' in value) ||
        isPlain(value)
      )
        return value;
      const label = String(value.label);
      const named =
        label === ''
          ? (this.modules.get(value as GPUShaderModule) ??
            this.layouts.get(value as GPUPipelineLayout))
          : label;
      return [value.constructor.name, named];
    });
  }

  private built(recipe: PipelineRecipe, pipeline: object, drawn: boolean): void {
    this.compiled.set(recipe.identity, pipeline);
    const kept = this.recipes.get(recipe.identity);
    const same = kept != null && sameRecipe(kept, recipe);
    const lastDrawn = drawn ? this.opened : same ? kept.lastDrawn : null;
    if (same && kept.lastUsed === this.opened && kept.lastDrawn === lastDrawn) return;
    this.recipes.set(recipe.identity, { ...recipe, lastDrawn });
    if (this.saveTimer != null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_QUIET_MS);
  }

  /**
   * Once, for the warm-up and for every save: a save before it would drop every recipe on disk.
   * False when unreadable: a save would then replace them with this session's.
   */
  private loadStored(): Promise<boolean> {
    this.storedLoaded ??= this.store.load().then(
      (stored) => {
        for (const recipe of stored?.recipes ?? []) {
          if (recipe.lastUsed <= this.opened - KEPT_UNUSED_MS) continue;
          const current = this.recipes.get(recipe.identity);
          if (current == null) this.recipes.set(recipe.identity, recipe);
          else if (current.lastDrawn == null && sameRecipe(current, recipe))
            this.recipes.set(recipe.identity, { ...current, lastDrawn: recipe.lastDrawn });
        }
        return true;
      },
      (error: unknown) => {
        log.warn('could not read the pipeline recipes, so none are saved this session', error);
        return false;
      },
    );
    return this.storedLoaded;
  }

  private async warm(device: GPUDevice, created: Created): Promise<void> {
    await this.loadStored();
    // Most stand-ins were handed out before this ran, with no recipe yet to tell them apart by.
    const changed = new Set<string>();
    for (const wait of this.undrawn()) {
      const kept = this.recipes.get(wait.recipe.identity);
      if (kept != null && !sameRecipe(kept, wait.recipe)) changed.add(wait.recipe.identity);
      this.arrived(wait);
    }
    const drawnSince = this.opened - KEPT_UNUSED_MS;
    const everything = !(await this.compilesSparingly);
    const owed = [...this.recipes.values()].filter(
      (recipe) =>
        (everything || (recipe.lastDrawn != null && recipe.lastDrawn > drawnSince)) &&
        !changed.has(recipe.identity) &&
        !this.compiled.has(recipe.identity),
    );
    if (owed.length === 0) return;

    // Scoped: a stale recipe's refusal would otherwise reach the module's handler and fail the editor.
    device.pushErrorScope('validation');
    const modules = new Map<string, GPUShaderModule>();
    const compiling: Promise<unknown>[] = [];
    try {
      for (const recipe of owed) {
        const build = (device as Builder)[`${recipe.build}Async`] as BuildAsync;
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
            created.createBindGroupLayout.call(device, group),
          ),
        });
        compiling.push(
          this.inTurn(() => build.call(device, descriptor as unknown as PipelineDescriptor)).then(
            (pipeline) => {
              this.compiled.set(recipe.identity, pipeline);
            },
          ),
        );
      }
    } finally {
      compiling.push(device.popErrorScope());
      await Promise.allSettled(compiling);
    }
  }

  private async save(): Promise<void> {
    this.saveTimer = null;
    if (!(await this.loadStored())) return;
    await this.store
      .save({ recipes: [...this.recipes.values()] })
      .catch((error: unknown) => log.warn('could not keep the pipeline recipes', error));
  }
}

/** What the device's patched creators recorded for `held`, which every module and layout passes through. */
function recorded<K extends object, V>(records: WeakMap<K, V>, held: K | null | undefined): V {
  const record = held == null ? undefined : records.get(held);
  if (record == null)
    throw new Error('PipelineWarmth: a GPU object was not created through its device');
  return record;
}

function isPlain(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameRecipe(a: PipelineRecipe, b: PipelineRecipe): boolean {
  return JSON.stringify([a.stages, a.groups]) === JSON.stringify([b.stages, b.groups]);
}

function methodsOf(prototype: object): string[] {
  const names = new Set<string>();
  for (let held: object | null = prototype; held != null && held !== Object.prototype;) {
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

export function storedRecipes(files: DeviceFiles): RecipeStore {
  const name = 'pipeline-recipes';
  return {
    load: async () => {
      const kept = await files.load(name);
      if (kept == null) return null;
      // Written by whichever build ran last, so a shape this one cannot read is a cache to rebuild.
      const recipes = RecipesSchema.safeParse(safeJson(kept));
      return recipes.success ? recipes.data : null;
    },
    save: (recipes) => files.save(name, JSON.stringify(recipes)),
  };
}
