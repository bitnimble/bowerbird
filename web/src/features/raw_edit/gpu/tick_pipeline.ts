// The tick, orchestrated.
//
// `Prepared` crosses once and becomes a storage buffer that stays on the GPU; after that a slider
// move writes a uniform and submits dispatches, and nothing is uploaded, downloaded or
// encoded (`docs/raw-edit-gpu.md` §6). The decode, the camera fit, the lens warp and the
// denoise all happened natively before the bytes arrived, so a tick is the grade alone.

import { type PassMs, PassTimer } from './pass_timer';
import {
  BALANCE,
  BALANCE_FLOATS,
  DECODE,
  DETAIL,
  FRAME,
  PEAK,
  PEAK_BINS,
  PEAK_CANDIDATES,
  PQ_CODES,
  REDUCE,
  TICK_UNIFORM_FLOATS,
  detailSize,
  peakSampling,
  tickOffsets,
} from './shaders';

/** Where each `Tick` field lives, by name. Computed once from the layout the shader declares. */
const AT = tickOffsets().at;

/**
 * Values per lattice node: a 2x2 on chroma, then a gain on luma.
 *
 * `hdr_fit::NODE_VALUES`. Held here rather than read off the payload so a server built
 * against a different model is a thrown error rather than a silent reinterpretation.
 */
const NODE_VALUES = 9;

export interface ChromaPayload {
  nodes: number[];
  chromaCount: number;
  levelCount: number;
  chromaLow: number;
  chromaScale: number;
  chromaLowBy: number;
  chromaScaleBy: number;
  levelScale: number;
}

export interface ColourPayload {
  curves: [number[], number[], number[]];
  matrix: [[number, number, number], [number, number, number], [number, number, number]];
  saturation: number;
  trustCeiling: number;
  chroma: ChromaPayload | null;
}

/** The illuminant the camera balanced a frame for, or null where it recorded none. */
export interface AsShot {
  temperature: number;
  tint: number;
}

export interface PreparedHeader {
  width: number;
  height: number;
  asShot: AsShot | null;
  white: number;
  peak: number;
  grade: { peakNits: number; referenceWhiteNits: number; whiteQuantile: number };
  strengths: { luma: number; chroma: number; sharpen: number; defringe: number };
  matched: boolean;
  colour: ColourPayload | null;
}

/**
 * BT.2408 reference white, and the divisor an extended-range canvas needs.
 *
 * Measured rather than assumed (`docs/raw-edit-gpu.md` §7.1): sweeping this against a real
 * PQ AVIF of the same pixels, Chrome and Safari both match at 203. It is the browser's
 * constant, not `Grade::reference_white_nits`, which a library is free to move.
 */
const SDR_WHITE_NITS = 203;

/** The part of the frame on screen, in source pixels. Zoom and pan move this and nothing else. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Canvas pixels per device pixel.
 *
 * The draw point-samples the region it shows, and a photograph's edges are exactly where
 * that reads as a jagged line rather than a soft one. Rendering half again as wide and
 * letting the compositor's own downscale do the smoothing is the cheap version of an
 * antialiased draw, and it is cheap because the cost is per canvas pixel: 1.5 costs 2.25x
 * a pass that no longer scales with the frame at all.
 */
export const SUPERSAMPLE = 1.5;

/**
 * The backing store to give the canvas, for a CSS box and the region it is showing.
 *
 * The shape is the region's, not the box's. The element is laid out `object-fit: contain`
 * and the draw fills whatever canvas it is given, so a backing store of a different aspect
 * ratio is a stretched photograph. Fitting here rather than letterboxing in the shader
 * also means no canvas pixel is ever drawn and then thrown away.
 *
 * Then the two multipliers and the two clamps. `devicePixelRatio` is how many device
 * pixels a CSS pixel is, so without it a Retina panel shows a half-resolution picture, and
 * `SUPERSAMPLE` is on top of that. The clamps stop them compounding into nonsense: past
 * the region's own resolution there is nothing left to resolve, and past
 * `maxTextureDimension2D` there is no canvas.
 *
 * Exported because sizing the canvas belongs to whoever owns the element, and reading a
 * layout box is not something the tick may do.
 */
export function stageResolution(
  css: { width: number; height: number },
  region: Region,
  maxTexture: number,
): { width: number; height: number } {
  const dpr = globalThis.devicePixelRatio || 1;
  const contain = Math.min(css.width / region.width, css.height / region.height);
  const scale = contain * dpr * SUPERSAMPLE;
  const fit = (source: number): number =>
    Math.max(1, Math.min(Math.round(source * scale), Math.ceil(source), maxTexture));
  return { width: fit(region.width), height: fit(region.height) };
}

/**
 * What to ask `requestDevice` for before building a `TickPipeline` on it.
 *
 * Nothing required, and that is the point. This used to demand `float32-filterable` for the
 * chroma map, which no Apple GPU offers - Metal gates 32-bit float filtering behind
 * `MTLDevice.supports32BitFloatFiltering`, true on a few iPad parts and on no iPhone - so
 * every RAW refused to open on iOS, matched or not. The map is `rgba16float` instead, which
 * core WebGPU filters everywhere.
 *
 * `timestamp-query` is optional in the ordinary way: without it the readout loses its
 * per-pass milliseconds and the picture is identical.
 */
export function tickFeatures(adapter: GPUAdapter): GPUFeatureName[] {
  return (['timestamp-query'] as GPUFeatureName[]).filter((feature) =>
    adapter.features.has(feature),
  );
}

/** The bytes a frame's samples occupy on the GPU: interleaved RGB `u16`, padded to a word. */
export function frameBytes(width: number, height: number): number {
  return Math.ceil((width * height * 3 * 2 + 3) / 4) * 4;
}

/**
 * Why a frame will not open on this adapter, or `null` if it will.
 *
 * Both halves are said here rather than left to the driver, because neither is an exception
 * where it happens: an oversized texture or buffer is a *validation* error, which drops the
 * dispatch and reads as a very fast tick rather than as a failure - the reader is told `live`
 * over a black canvas, and this has cost a morning twice.
 *
 * The side is measured against the pyramid rather than against the frame, because the frame is
 * not a texture: it stays an interleaved buffer, and the largest texture made from it is the
 * pyramid's base at half a side. Held to the frame's own width this refused a 9504px sensor on
 * any adapter capped at 8192 - most phones, and the Android build cannot raise the cap past
 * what its GPU offers - for a texture it was never going to create.
 *
 * What such a frame needs instead is buffer capacity, and that is the check the side used to
 * stand in for: at 61MP the samples are 361MB against a 256MB default, and against whatever
 * the adapter itself will admit once `tickLimits` has asked for its maximum. Storage binding
 * as well as allocation, since the frame is bound to every pass that reads it.
 */
export function frameTooBig(
  width: number,
  height: number,
  limits: { maxTextureDimension2D: number; maxBufferSize: number; maxStorageBufferBindingSize: number },
): string | null {
  const side = Math.max(width, height) >> 1;
  if (side > limits.maxTextureDimension2D) {
    const held = limits.maxTextureDimension2D * 2;
    return `this GPU holds frames to ${held}px a side; this one is ${width}x${height}`;
  }
  const bytes = frameBytes(width, height);
  const room = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  if (bytes > room) {
    const megabytes = (n: number): string => `${Math.round(n / 1024 / 1024)}MB`;
    return `this GPU holds frames to ${megabytes(room)}; this one is ${megabytes(bytes)}`;
  }
  return null;
}

/**
 * The limits a full-resolution frame needs, which are nothing like the defaults.
 *
 * `requestDevice` hands back the *default* limits however capable the adapter is, and the
 * defaults are sized for a web page rather than for a sensor: `maxTextureDimension2D` is
 * 8192 against the 9504 a 61MP frame is wide, and `maxBufferSize` is 256MB against the
 * 366MB that frame's levels take.
 *
 * Asked for as the adapter's own maximum rather than as a computed need, because the
 * alternative is re-requesting a device when a larger photograph is opened.
 */
export function tickLimits(adapter: GPUAdapter): Record<string, number> {
  const { maxTextureDimension2D, maxBufferSize, maxStorageBufferBindingSize } = adapter.limits;
  return { maxTextureDimension2D, maxBufferSize, maxStorageBufferBindingSize };
}

export class TickPipeline {
  /**
   * One buffer, written once per submit and read by every pass in it.
   *
   * Sound only while no two passes of one submit want different values: `queue.writeBuffer`
   * lands before the command buffer it was recorded alongside runs, so a second write would
   * reach the earlier passes too. Add a buffer per pass on the day a pass needs its own.
   */
  private readonly uniform: GPUBuffer;
  private readonly histogram: GPUBuffer;
  private readonly peak: GPUBuffer;
  private readonly candidates: GPUBuffer;
  /**
   * Whether the kept candidates are every qualifying pixel rather than the first of many.
   *
   * False until the open's count says otherwise, which is the answer that is always correct:
   * a tick that reads the frame measures the same peak, only slower.
   */
  private useCandidates = false;
  private readonly matrix: GPUBuffer;
  /** The frame as it arrived: interleaved RGB `u16`, three to a pixel. */
  private readonly frame: GPUBuffer;
  /** Half resolution and down. `lod` 0 is the frame; level L here is `lod` L + 1. */
  private readonly pyramid: GPUTexture;
  private readonly levels: number;
  private readonly curves: GPUTexture;
  private readonly chroma: GPUTexture;
  /** The lattice's luma gain, which does not fit beside the 2x2 in one texel. */
  private readonly chromaLuma: GPUTexture;
  private readonly chromaTint: GPUTexture;
  /**
   * The blur the presence sliders read, and the scratch the separable pair ping-pongs
   * through. Three passes, so the result lands back in `detail` and only that one is bound.
   */
  private readonly detail: GPUTexture;
  private readonly detailScratch: GPUTexture;
  /** The reader's temperature and tint as one matrix, rewritten by the pass below per tick. */
  private readonly balance: GPUBuffer;
  private readonly balancePipeline: GPUComputePipeline;
  private readonly balanceGroup: GPUBindGroup;
  /**
   * The frame's coding undone, one entry per `u16` code.
   *
   * The samples arrive in normalised PQ (`tone::encode_base`) rather than as sensor levels,
   * because every stage between the decode and here reads a difference against a blur and so
   * needed a perceptual domain; coded once on the way out, none of them has to convert. This
   * is what the grade reads them back through, and it is filled by the shader rather than
   * computed here so that `pq_inv` stays the one in `prelude.wgsl`.
   *
   * The same table for every photograph - `encode_base` anchors the frame to the reference
   * white before coding it - so it could outlive one open. It does not, only because a
   * pipeline owns its own buffers and 256kB is not worth a second lifetime to reason about.
   */
  private readonly nitsOfCode: GPUBuffer;
  private readonly lerp: GPUSampler;

  private readonly peakMeasure: GPUComputePipeline;
  private readonly peakCollect: GPUComputePipeline;
  private readonly peakRemeasure: GPUComputePipeline;
  private readonly peakQuantile: GPUComputePipeline;
  private readonly encodePipeline: GPUComputePipeline;
  /** The same draw, compiled to read the frame's buffer or the pyramid, never both. */
  private readonly drawFromFrame: GPURenderPipeline;
  private readonly drawFromPyramid: GPURenderPipeline;
  private readonly peakLayout: GPUBindGroupLayout;
  private readonly encodeLayout: GPUBindGroupLayout;
  private readonly drawLayout: GPUBindGroupLayout;

  private readonly width: number;
  private readonly height: number;
  /** Rows apart the peak samples, so it reads about `PEAK_SAMPLES` of them. */
  private readonly rowStride: number;
  private readonly timer: PassTimer | null;

  constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly header: PreparedHeader,
    samples: Uint16Array<ArrayBuffer>,
  ) {
    this.timer = PassTimer.supported(device) ? new PassTimer(device) : null;
    this.width = header.width;
    this.height = header.height;
    this.rowStride = peakSampling(this.width, this.height).rowStride;

    const tooBig = frameTooBig(this.width, this.height, device.limits);
    if (tooBig != null) throw new Error(tooBig);
    // The frame as it arrived: interleaved RGB `u16`, no fourth component and no second
    // copy to add one. At 61MP that is 361MB rather than 481.
    this.frame = device.createBuffer({
      size: frameBytes(this.width, this.height),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    // In whole 4-byte words, then the odd `u16` on its own. `writeBuffer` rejects a size
    // that is not a multiple of four, and three `u16` a pixel is exactly that whenever both
    // dimensions are odd - a validation error, so the frame would stay zeroed and the
    // picture black, on nothing more exotic than a fit that landed on 3841x2561.
    const words = samples.length & ~1;
    device.queue.writeBuffer(this.frame, 0, samples, 0, words);
    if (words !== samples.length) {
      device.queue.writeBuffer(this.frame, words * 2, new Uint16Array([samples[words]!, 0]));
    }

    // Half resolution and down, so the frame is not stored twice: a third of half a frame
    // rather than a third of a whole one, and the level it leaves out is the one the draw
    // reads from the buffer anyway. The whole chain below that, since each level is a
    // quarter of the one above and the coarse end is what a reader zoomed out is looking at.
    const half: [number, number] = [
      Math.max(1, this.width >> 1),
      Math.max(1, this.height >> 1),
    ];
    this.levels = Math.floor(Math.log2(Math.max(...half))) + 1;
    this.pyramid = device.createTexture({
      size: half,
      format: 'rgba16uint',
      mipLevelCount: this.levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    const storage = (length: number) =>
      device.createBuffer({
        size: length * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });

    this.uniform = device.createBuffer({
      size: TICK_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.histogram = storage(PEAK_BINS);
    this.peak = storage(4);
    // A count, three words of padding to keep the levels aligned, and four per candidate.
    this.candidates = storage(4 + PEAK_CANDIDATES * 4);
    this.nitsOfCode = storage(PQ_CODES);
    this.balance = storage(BALANCE_FLOATS);
    const balanceLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 14, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    this.balancePipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [balanceLayout] }),
      compute: {
        module: device.createShaderModule({ code: BALANCE, label: 'balance' }),
        entryPoint: 'balance',
      },
    });
    this.balanceGroup = device.createBindGroup({
      layout: balanceLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 14, resource: { buffer: this.balance } },
      ],
    });

    const colour = header.colour;
    // A row per channel, which is how the shader picks one: `sample_curve` loads the two
    // texels of its own row by index, so nothing can blend red into green.
    const bins = colour ? colour.curves[0].length : 1;
    this.curves = this.lookup(
      [bins, 3],
      '2d',
      'r32float',
      4,
      new Float32Array(colour?.curves.flat() ?? [0, 0, 0]),
    );
    // A node lattice is exactly a volume, so `ChromaMap`'s trilinear is what a 3D texture
    // does for free. It takes two of them: the 2x2 on chroma fills an `rgba16float` texel
    // exactly, and the luma gain that follows it does not fit beside them. Splitting is
    // what keeps both halves hardware-filtered - packing two nodes to a texel would lose
    // the filter on whichever axis was doubled, and widening the volume would mean
    // interpolating in the shader. Same coordinate for both, so the eight corners and the
    // weights are shared and the result equals the CPU's one interpolation.
    //
    // Half floats because `f32` is not filterable on any Apple GPU (`tickFeatures`), and the
    // 2^-11 that costs is measured rather than assumed: over the parity fixtures and over
    // every colour the lattice spans, the worst pixel moves 0.109 deltaE ITP, where 1.0 is
    // the threshold of visibility. The corrections multiply chroma differences, so the error
    // vanishes on the grey axis where the eye is least forgiving, and quantising nodes before
    // interpolating them leaves the surface continuous - no contour to see.
    const chroma = colour?.chroma;
    const size: [number, number, number] = [
      chroma?.chromaCount ?? 1,
      chroma?.chromaCount ?? 1,
      chroma?.levelCount ?? 1,
    ];
    // Derived rather than carried. The grid's own dimensions have to be right for the
    // texture to exist at all, so the values per node follow from them exactly - where a
    // field stating it is one more thing that can disagree with the array beside it, and
    // disagree silently: a client reading five values as four lands every node after the
    // first one slot out, which renders as plausible colour rather than as an error. A
    // server built before the lattice grew its lightness term sends four, and this is
    // where that has to be loud.
    const count = chroma ? chroma.chromaCount * chroma.chromaCount * chroma.levelCount : 1;
    if (chroma && chroma.nodes.length !== count * NODE_VALUES) {
      throw new Error(
        `the chroma lattice has ${chroma.nodes.length} values for ${count} nodes, where this ` +
          `reader expects ${NODE_VALUES} each - the payload was built by a different model`,
      );
    }
    const pairs = new Float16Array(count * 4);
    const gains = new Float16Array(count * 4);
    const tints = new Float16Array(count * 4);
    for (let node = 0; node < count; node++) {
      const at = node * NODE_VALUES;
      // The length was checked against `count * NODE_VALUES` above, so every offset below is
      // in range and the fallback never fires. It is written because `web/tsconfig.json` sets
      // `noUncheckedIndexedAccess`, which the root one does not - so this file typechecks at
      // the root and failed `bun run build` here.
      const value = (offset: number): number => (chroma ? (chroma.nodes[at + offset] ?? 0) : 0);
      for (let k = 0; k < 4; k++) pairs[node * 4 + k] = value(k);
      // The *deviation* from 1, which `correct` adds back. Half floats spend a fixed
      // relative precision wherever the value sits, so storing 1.02 puts 2^-11 of full
      // scale on the gain and storing 0.02 puts it on the deviation - worth 16x, and
      // needed because this multiplies luma where the 2x2 above multiplies chroma
      // differences. Stored as a gain the parity fixtures miss by 1.33 against a 0.5
      // bound, and every count of that is f16.
      //
      // 0 rather than 1 where there is no map, for the same reason: an absent correction
      // is no deviation, and it has to leave lightness alone rather than take it to black.
      // The rest of the node: the two luma-to-chroma terms, the lightness gain's deviation,
      // then the first of the two chroma-to-lightness terms. Nine values do not fit two
      // texels, so the ninth takes a third volume of its own.
      gains[node * 4] = value(4);
      gains[node * 4 + 1] = value(5);
      gains[node * 4 + 2] = chroma ? value(6) - 1 : 0;
      gains[node * 4 + 3] = value(7);
      tints[node * 4] = value(8);
    }
    this.chroma = this.lookup(size, '3d', 'rgba16float', 8, pairs);
    this.chromaLuma = this.lookup(size, '3d', 'rgba16float', 8, gains);
    // One value in a four-component texture. `r16float` would be a quarter of it, and the
    // whole volume is 5x5x4, so the three wasted channels cost 600 bytes and buy the same
    // filtering path the textures beside it are already proven on.
    this.chromaTint = this.lookup(size, '3d', 'rgba16float', 8, tints);
    const working = detailSize(this.width, this.height);
    const detailTexture = (label: string) =>
      device.createTexture({
        label,
        size: [working.width, working.height],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
      });
    this.detail = detailTexture('detail');
    this.detailScratch = detailTexture('detail scratch');
    this.lerp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.matrix = this.upload(
      new Float32Array(colour ? colour.matrix.flat() : [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    );
    const frame = device.createShaderModule({ code: FRAME, label: 'frame' });
    const peak = device.createShaderModule({ code: PEAK, label: 'peak' });

    // Explicit layouts rather than `auto`, because `auto` derives the layout from what an
    // entry point happens to reference rather than from what the module declares: `encode`
    // never calls `covered`, so it never reaches the pyramid at binding 9, and a layout
    // derived for it has eight of `FRAME`'s nine bindings - which rejects the bind group
    // built for the shader as written. Two layouts over the one module instead, differing
    // only in the stage that sees them and in `counts`, which only `encode` writes.
    const bindings = (visibility: number) => ({
      colour: [
        { binding: 0, visibility, buffer: { type: 'uniform' as const } },
        { binding: 1, visibility, buffer: { type: 'read-only-storage' as const } },
        // Declared for what an `r32float` view actually is without `float32-filterable`,
        // which is `unfilterable-float`. The default is `float`, and against this texture
        // that is rejected where the bind group is built - asynchronously, to an
        // uncaptured-error handler nothing installs, and not as an exception the open can
        // catch. `sample_curve` only ever loads from it, so nothing is given up.
        { binding: 2, visibility, texture: { sampleType: 'unfilterable-float' as const } },
        { binding: 3, visibility, texture: { viewDimension: '3d' as const } },
        { binding: 4, visibility, buffer: { type: 'read-only-storage' as const } },
        { binding: 7, visibility, sampler: {} },
        { binding: 10, visibility, texture: { viewDimension: '3d' as const } },
        { binding: 11, visibility, texture: { viewDimension: '3d' as const } },
        { binding: 12, visibility, buffer: { type: 'read-only-storage' as const } },
        { binding: 13, visibility, texture: {} },
        { binding: 14, visibility, buffer: { type: 'read-only-storage' as const } },
      ],
      pyramid: { binding: 9, visibility, texture: { sampleType: 'uint' as const } },
      readOnly: (binding: number) => ({
        binding,
        visibility,
        buffer: { type: 'read-only-storage' as const },
      }),
      writable: (binding: number) => ({
        binding,
        visibility,
        buffer: { type: 'storage' as const },
      }),
    });
    const c = bindings(GPUShaderStage.COMPUTE);
    const f = bindings(GPUShaderStage.FRAGMENT);

    this.peakLayout = device.createBindGroupLayout({
      entries: [...c.colour, c.writable(5), c.writable(6), c.writable(8)],
    });
    this.encodeLayout = device.createBindGroupLayout({
      entries: [...c.colour, c.readOnly(5), c.writable(6), c.pyramid],
    });
    this.drawLayout = device.createBindGroupLayout({
      entries: [...f.colour, f.readOnly(5), f.pyramid],
    });

    const compute = (module: GPUShaderModule, entryPoint: string, layout: GPUBindGroupLayout) =>
      device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint },
      });

    const onPeak = (entryPoint: string) => compute(peak, entryPoint, this.peakLayout);
    this.peakMeasure = onPeak('measure');
    this.peakCollect = onPeak('collect');
    this.peakRemeasure = onPeak('remeasure');
    this.peakQuantile = onPeak('quantile');
    this.encodePipeline = compute(frame, 'encode', this.encodeLayout);
    // Two pipelines over one entry point, differing in which of the frame and the pyramid
    // `covered` is compiled to read. `render` picks by the ratio it is drawing at.
    const drawing = (fromFrame: boolean) =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [this.drawLayout] }),
        vertex: { module: frame, entryPoint: 'vs' },
        fragment: {
          module: frame,
          entryPoint: 'fs',
          constants: { FROM_FRAME: fromFrame ? 1 : 0 },
          targets: [{ format: 'rgba16float' }],
        },
        primitive: { topology: 'triangle-list' },
      });
    this.drawFromFrame = drawing(true);
    this.drawFromPyramid = drawing(false);

    this.colourEntries = [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: { buffer: this.frame } },
      { binding: 2, resource: this.curves.createView() },
      { binding: 3, resource: this.chroma.createView() },
      { binding: 4, resource: { buffer: this.matrix } },
      { binding: 7, resource: this.lerp },
      { binding: 10, resource: this.chromaLuma.createView() },
      { binding: 11, resource: this.chromaTint.createView() },
      { binding: 12, resource: { buffer: this.nitsOfCode } },
      { binding: 13, resource: this.detail.createView() },
      { binding: 14, resource: { buffer: this.balance } },
    ];
    this.displayEntries = [
      ...this.colourEntries,
      { binding: 5, resource: { buffer: this.peak } },
      { binding: 9, resource: this.pyramid.createView() },
    ];
    this.peakEntries = [
      ...this.colourEntries,
      { binding: 5, resource: { buffer: this.histogram } },
      { binding: 6, resource: { buffer: this.peak } },
      { binding: 8, resource: { buffer: this.candidates } },
    ];
    this.drawGroup = device.createBindGroup({
      layout: this.drawLayout,
      entries: this.displayEntries,
    });
    this.peakGroup = device.createBindGroup({
      layout: this.peakLayout,
      entries: this.peakEntries,
    });

    this.decode();
    this.reduce();
    this.buildDetail();
    if (header.matched) this.chooseCandidates();
  }

  /**
   * The frame's coding undone, filled once before anything reads the frame.
   *
   * Its own module and its own layout because `colour.wgsl` binds the same table read-only,
   * and a module cannot declare one binding twice with two access modes.
   */
  private decode(): void {
    const layout = this.device.createBindGroupLayout({
      entries: [{ binding: 12, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(
      this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: {
          module: this.device.createShaderModule({ code: DECODE, label: 'decode' }),
          entryPoint: 'pq_table',
        },
      }),
    );
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout,
        entries: [{ binding: 12, resource: { buffer: this.nitsOfCode } }],
      }),
    );
    pass.dispatchWorkgroups(PQ_CODES / 64);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * The blur the presence sliders read, built once at the open (`detail.wgsl`).
   *
   * Unconditional, rather than deferred until a reader touches one of the three. The frame is
   * read once and the two Gaussians run over a 512px texture, which is a fraction of what
   * `reduce` above already costs - against which the alternative is a lazily built resource
   * whose absence a slider would have to notice mid-drag.
   *
   * Ping-ponged so the result lands in `detail`: shrink writes it, the horizontal pass reads
   * it into the scratch, and the vertical pass reads the scratch back into it. Three passes
   * is odd, which is what makes that work.
   */
  private buildDetail(): void {
    const COMPUTE = GPUShaderStage.COMPUTE;
    const written = {
      binding: 3,
      visibility: COMPUTE,
      storageTexture: { access: 'write-only' as const, format: 'rgba16float' as const },
    };
    const shrinkLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: COMPUTE, buffer: { type: 'read-only-storage' } },
        written,
        { binding: 12, visibility: COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    // Loaded rather than sampled, so the view is declared for what an `rgba16float` texture is
    // to `textureLoad` and no sampler enters this pass at all.
    const blurLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 2, visibility: COMPUTE, texture: {} }, written],
    });

    const module = this.device.createShaderModule({ code: DETAIL, label: 'detail' });
    const pipelineFor = (entryPoint: string, layout: GPUBindGroupLayout) =>
      this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint },
      });
    const shrink = pipelineFor('shrink', shrinkLayout);
    const blurX = pipelineFor('blur_x', blurLayout);
    const blurY = pipelineFor('blur_y', blurLayout);

    const working = detailSize(this.width, this.height);
    const [x, y] = this.groups(working.width, working.height);
    const encoder = this.device.createCommandEncoder();
    const run = (
      pipeline: GPUComputePipeline,
      layout: GPUBindGroupLayout,
      entries: GPUBindGroupEntry[],
    ): void => {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device.createBindGroup({ layout, entries }));
      pass.dispatchWorkgroups(x, y);
      pass.end();
    };

    run(shrink, shrinkLayout, [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: { buffer: this.frame } },
      { binding: 3, resource: this.detail.createView() },
      { binding: 12, resource: { buffer: this.nitsOfCode } },
    ]);
    run(blurX, blurLayout, [
      { binding: 2, resource: this.detail.createView() },
      { binding: 3, resource: this.detailScratch.createView() },
    ]);
    run(blurY, blurLayout, [
      { binding: 2, resource: this.detailScratch.createView() },
      { binding: 3, resource: this.detail.createView() },
    ]);
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * The pyramid the draw averages with, one level per dispatch, once at the open.
   *
   * The first level comes off the frame's buffer and every level after it off the one
   * above, which is two entry points over one layout rather than a padded copy of the
   * frame to reduce from.
   */
  private reduce(): void {
    const COMPUTE = GPUShaderStage.COMPUTE;
    const written = {
      binding: 3,
      visibility: COMPUTE,
      storageTexture: { access: 'write-only' as const, format: 'rgba16uint' as const },
    };
    // A layout each, holding exactly what its entry point reads. One shared layout would
    // have to name `coarser`, and for the first level the only texture to put there is the
    // one being written - which is a read and a write of one resource in a single pass, and
    // rejected as such.
    const first = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: COMPUTE, buffer: { type: 'read-only-storage' } },
        written,
      ],
    });
    const rest = this.device.createBindGroupLayout({
      entries: [{ binding: 2, visibility: COMPUTE, texture: { sampleType: 'uint' } }, written],
    });

    const module = this.device.createShaderModule({ code: REDUCE, label: 'reduce' });
    const pipelineFor = (entryPoint: string, layout: GPUBindGroupLayout) =>
      this.device.createComputePipeline({
        layout: this.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint },
      });
    const halve = pipelineFor('halve', first);
    const reduce = pipelineFor('reduce', rest);
    const oneLevel = (baseMipLevel: number): GPUTextureView =>
      this.pyramid.createView({ baseMipLevel, mipLevelCount: 1 });

    this.writeUniform();
    const encoder = this.device.createCommandEncoder();
    for (let level = 0; level < this.levels; level++) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(level === 0 ? halve : reduce);
      pass.setBindGroup(
        0,
        this.device.createBindGroup({
          layout: level === 0 ? first : rest,
          entries:
            level === 0
              ? [
                  { binding: 0, resource: { buffer: this.uniform } },
                  { binding: 1, resource: { buffer: this.frame } },
                  { binding: 3, resource: oneLevel(0) },
                ]
              : [
                  { binding: 2, resource: oneLevel(level - 1) },
                  { binding: 3, resource: oneLevel(level) },
                ],
        }),
      );
      const [x, y] = this.groups(
        Math.max(1, this.width >> (level + 1)),
        Math.max(1, this.height >> (level + 1)),
      );
      pass.dispatchWorkgroups(x, y);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * Grades at `ev` stops and puts `region` of the frame on the canvas.
   *
   * `region` is in source pixels and defaults to the whole frame; it is what zoom and pan
   * move. Not the peak's business, and deliberately: that reads the whole frame at a fixed
   * stride whatever is on screen, or the highlight roll-off would shift as the reader
   * panned from a dark part of the picture to a bright one.
   *
   * One submit, no readback.
   */
  render(ev: number, region: Region = this.wholeFrame): void {
    const encoder = this.device.createCommandEncoder();
    this.timer?.begin();
    this.writeUniform({ exposure: 2 ** ev, region });

    this.writeBalance(encoder);
    if (this.header.matched) this.measurePeak(encoder);
    this.draw(encoder, region);

    this.timer?.resolve(encoder);
    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * The reader's temperature and tint, solved into the matrix the grade reads.
   *
   * In every submit that grades rather than once, because the pair moves with a slider and one
   * invocation costs nothing. What it must never be is *after* the passes that read it: the
   * peak measures through the whole colour transform, so a balance written later would leave
   * the roll-off knee placed for the previous frame's colour.
   */
  private writeBalance(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.balancePipeline);
    pass.setBindGroup(0, this.balanceGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  /** The whole frame, which is what a fresh open shows. */
  get wholeFrame(): Region {
    return { x: 0, y: 0, width: this.width, height: this.height };
  }

  /**
   * Whether a tick measures the peak off the kept candidates or off the frame.
   *
   * Exposed for the harness. Both answers are correct - the fallback is what the candidates
   * replaced - so the failure this guards is the quiet one: the count never arriving, or the
   * rule inverting, and every tick paying the millisecond that `collect` exists to avoid,
   * with the picture identical either way.
   */
  get readsCandidates(): boolean {
    return this.useCandidates;
  }


  /** Milliseconds per pass of the last `render`, if the adapter can tell us. */
  passMs(): Promise<PassMs> {
    return this.timer?.read() ?? Promise.resolve({});
  }

  /**
   * The scene peak at each `ev` both ways: off the kept candidates, and off a full sample.
   *
   * The evidence for `collect`, and here rather than in a harness so that it can be run
   * against a real frame whenever the candidate count or the selection changes. What it
   * has to show is that the two agree across the slider's whole range - the candidates are
   * chosen once at neutral exposure, and the claim is that the exposure cannot reorder the
   * frame enough to push an uncollected pixel into the top hundred.
   */
  async peakSweep(evs: number[]): Promise<{ ev: number; candidates: number; full: number }[]> {
    const staging = this.device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const [x, y] = this.sampledGroups;

    const run = async (ev: number, fromCandidates: boolean): Promise<number> => {
      const encoder = this.device.createCommandEncoder();
      this.timer?.begin();
      this.writeUniform({ exposure: 2 ** ev });
      this.writeBalance(encoder);
      encoder.clearBuffer(this.histogram);
      this.peakPass(
        encoder,
        fromCandidates
          ? [['remeasure', this.peakRemeasure, Math.ceil(PEAK_CANDIDATES / 64), 1]]
          : [['measure', this.peakMeasure, x, y]],
      );
      this.peakPass(encoder, [['quantile', this.peakQuantile, 1, 1]]);
      encoder.copyBufferToBuffer(this.peak, 0, staging, 0, 16);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const nits = new Float32Array(staging.getMappedRange())[0]!;
      staging.unmap();
      return nits;
    };

    const sweep = [];
    for (const ev of evs) {
      sweep.push({ ev, candidates: await run(ev, true), full: await run(ev, false) });
    }
    // The last run left the peak at whatever the sweep ended on, so put it back where a
    // tick would have it before handing the pipeline back.
    await run(0, true);
    staging.destroy();
    return sweep;
  }

  /**
   * The graded frame as a rendition would hold it, for the parity harness.
   *
   * `u16` counts of PQ, which is the unit the fixture and every other pin in this repo is
   * written in - and which the tick itself no longer produces, since a display wants nits.
   * Built here rather than on the way out because ST 2084 has one implementation in this
   * repo's shaders and this is not the place to write a second.
   */
  async readFrame(): Promise<Uint16Array> {
    const pixels = this.width * this.height;
    const bytes = this.encodeWords * 4;
    const counts = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const staging = this.device.createBuffer({
      size: bytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = this.device.createCommandEncoder();
    this.writeBalance(encoder);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.encodePipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.encodeLayout,
        entries: [...this.displayEntries, { binding: 6, resource: { buffer: counts } }],
      }),
    );
    const [x, y] = this.encodeGroups();
    pass.dispatchWorkgroups(x, y);
    pass.end();
    encoder.copyBufferToBuffer(counts, 0, staging, 0, staging.size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);

    // Already `u16` in the words, so this reads them rather than converting: two components
    // to a word, and the odd pixel's padding word dropped by taking only what the frame has.
    const frame = new Uint16Array(staging.getMappedRange().slice(0)).subarray(0, pixels * 3);
    staging.unmap();
    staging.destroy();
    counts.destroy();
    return frame;
  }

  destroy(): void {
    this.timer?.destroy();
    for (const texture of [
      this.pyramid,
      this.curves,
      this.chroma,
      this.chromaLuma,
      this.chromaTint,
      this.detail,
      this.detailScratch,
    ]) {
      texture.destroy();
    }
    for (const buffer of [
      this.uniform,
      this.frame,
      this.histogram,
      this.peak,
      this.candidates,
      this.matrix,
      this.nitsOfCode,
      this.balance,
    ]) {
      buffer.destroy();
    }
  }

  /** A lookup table the sampler can read: `f32` throughout, so the values are the CPU's. */
  private lookup(
    size: [number, number] | [number, number, number],
    dimension: '2d' | '3d',
    format: GPUTextureFormat,
    bytesPerTexel: number,
    values: Float32Array<ArrayBuffer> | Float16Array<ArrayBuffer>,
  ): GPUTexture {
    const texture = this.device.createTexture({
      size,
      dimension,
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      values,
      { bytesPerRow: size[0] * bytesPerTexel, rowsPerImage: size[1] },
      size,
    );
    return texture;
  }

  private upload(data: Float32Array<ArrayBuffer>): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: Math.max(data.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private writeUniform(over: { exposure?: number; region?: Region } = {}): void {
    const header = this.header;
    const colour = header.colour;
    if (over.exposure != null) this.exposure = over.exposure;
    const values = new Float32Array(TICK_UNIFORM_FLOATS);
    const ints = new Uint32Array(values.buffer);
    ints[AT.width] = this.width;
    ints[AT.height] = this.height;
    values[AT.white] = header.white;
    values[AT.source_level] = header.peak;
    values[AT.reference] = header.grade.referenceWhiteNits;
    values[AT.peak] = header.grade.peakNits;
    values[AT.exposure] = this.exposure;
    // `output` stays 0, which is PQ. The editor's `readFrame` wants the same 16-bit PQ a
    // still rendition does; the sRGB arm exists for the server, whose SDR renditions are
    // this grade with the peak at diffuse white and this transfer instead.
    ints[AT.matched] = header.matched ? 1 : 0;
    values[AT.saturation] = colour?.saturation ?? 1;
    ints[AT.has_chroma] = colour?.chroma == null ? 0 : 1;
    ints[AT.curve_bins] = colour ? colour.curves[0].length : 2;
    values[AT.trust_ceiling] = colour?.trustCeiling ?? 1;
    ints[AT.chroma_count] = colour?.chroma?.chromaCount ?? 2;
    ints[AT.level_count] = colour?.chroma?.levelCount ?? 2;
    values[AT.chroma_low] = colour?.chroma?.chromaLow ?? 0;
    values[AT.chroma_scale] = colour?.chroma?.chromaScale ?? 1;
    values[AT.chroma_low_by] = colour?.chroma?.chromaLowBy ?? 0;
    values[AT.chroma_scale_by] = colour?.chroma?.chromaScaleBy ?? 1;
    values[AT.level_scale] = colour?.chroma?.levelScale ?? 1;
    values[AT.sdr_white] = SDR_WHITE_NITS;
    ints[AT.row_stride] = this.rowStride;
    ints[AT.peak_samples] = peakSampling(this.width, this.height).peakSamples;

    const region = over.region ?? this.wholeFrame;
    const canvas = this.context.canvas;
    values[AT.region_origin] = region.x;
    values[AT.region_origin + 1] = region.y;
    values[AT.region_size] = region.width;
    values[AT.region_size + 1] = region.height;
    values[AT.canvas_size] = canvas.width;
    values[AT.canvas_size + 1] = canvas.height;
    // `lod` 0 is the frame itself, so the pyramid's levels are 1..levels.
    ints[AT.max_lod] = this.levels;

    // The reader's own sliders. All zero until something sets them, which is what an
    // unedited photo carries and what makes `adjusted` a no-op on it.
    values[AT.contrast] = this.adjust.contrast;
    values[AT.highlights] = this.adjust.highlights;
    values[AT.shadows] = this.adjust.shadows;
    values[AT.whites] = this.adjust.whites;
    values[AT.blacks] = this.adjust.blacks;
    values[AT.vibrance] = this.adjust.vibrance;
    values[AT.sat_adjust] = this.adjust.saturation;
    values[AT.texture_adjust] = this.adjust.texture;
    values[AT.clarity] = this.adjust.clarity;
    values[AT.dehaze] = this.adjust.dehaze;

    // Zero where the frame has no as-shot illuminant at all, which the shader reads as "leave
    // the balance alone" - the only honest answer with no baseline to move away from.
    // Otherwise the frame's own pair stands in for whichever half the document leaves null, so
    // an unedited photo asks for exactly the illuminant it was shot under and the shader's
    // identity arm takes it.
    const asShot = header.asShot;
    values[AT.as_shot_temperature] = asShot?.temperature ?? 0;
    values[AT.as_shot_tint] = asShot?.tint ?? 0;
    values[AT.temperature] = asShot == null ? 0 : (this.adjust.temperature ?? asShot.temperature);
    values[AT.tint] = asShot == null ? 0 : (this.adjust.tint ?? asShot.tint);

    this.device.queue.writeBuffer(this.uniform, 0, values);
  }

  private exposure = 1;

  /**
   * The tonal, presence and colour sliders, on Camera Raw's -100..100 scales.
   *
   * Held here rather than passed per tick because they change on a slider release and a
   * tick happens per pointer move; `render` writes whatever is current. Zeroes mean the
   * camera's own rendering, which is what a photo nobody has edited grades to.
   */
  private adjust = {
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    vibrance: 0,
    saturation: 0,
    texture: 0,
    clarity: 0,
    dehaze: 0,
    /** Null is "as shot", which is what `EditDoc` stores until the reader moves the pair. */
    temperature: null as number | null,
    tint: null as number | null,
  };

  /** Everything but the exposure, which is a gain and travels with the tick. */
  setAdjust(next: Partial<typeof this.adjust>): void {
    this.adjust = { ...this.adjust, ...next };
  }

  private groups(x: number, y = 1): [number, number] {
    return [Math.ceil(x / 8), Math.ceil(y / 8)];
  }

  /**
   * `encode`'s dispatch: an invocation covers two pixels and a workgroup 64 of them.
   *
   * Two dimensions because one is not enough - a 61MP frame wants 476k workgroups against
   * the 65535 a single dimension allows. The shader folds `y` back in through
   * `num_workgroups`, so how it is split is entirely this side's choice.
   */
  private encodeGroups(): [number, number] {
    const wanted = Math.ceil(Math.ceil((this.width * this.height) / 2) / 64);
    const wide = Math.max(1, this.device.limits.maxComputeWorkgroupsPerDimension);
    const x = Math.max(1, Math.min(wanted, wide));
    return [x, Math.max(1, Math.ceil(wanted / x))];
  }

  /** Words `encode` writes: two `u16` components each, rounded to an invocation's three. */
  private get encodeWords(): number {
    return Math.ceil((this.width * this.height) / 2) * 3;
  }

  /**
   * Everything the colour transform reads, whichever entry point is reading it.
   *
   * Built once. A bind group names resources rather than their contents, and every resource
   * here is fixed at construction - `writeUniform`'s writes into `this.uniform` are invisible
   * to it, and the swapchain texture the draw ends at is an attachment rather than a binding.
   * So there is nothing per-tick about these, and rebuilding them was two texture views and
   * a validation pass per pass per frame for an object identical to the last one.
   */
  private readonly colourEntries: GPUBindGroupEntry[];

  /** The above plus the scene peak, which everything but the pass that measures it reads. */
  private readonly displayEntries: GPUBindGroupEntry[];

  /** The above with the histogram and the candidates, which only the peak's passes touch. */
  private readonly peakEntries: GPUBindGroupEntry[];

  /** The two groups nothing about a tick changes. `readFrame`'s is not one: it names a
   * `counts` buffer created for that one call. */
  private readonly drawGroup: GPUBindGroup;
  private readonly peakGroup: GPUBindGroup;

  /** The rows the peak samples, as a dispatch over about `PEAK_SAMPLES` pixels. */
  private get sampledGroups(): [number, number] {
    return [Math.ceil(this.width / 64), Math.ceil(this.height / this.rowStride)];
  }

  private peakPass(
    encoder: GPUCommandEncoder,
    passes: [string, GPUComputePipeline, number, number][],
  ): void {
    // A pass each rather than several dispatches in one, so each reports its own time: a
    // dispatch over a million pixels and a dispatch over one workgroup are the same shape
    // from outside, and the difference is what the tick is being tuned on.
    for (const [label, pipeline, x, y] of passes) {
      const pass = encoder.beginComputePass({ timestampWrites: this.timer?.writes(label) });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.peakGroup);
      pass.dispatchWorkgroups(x, y);
      pass.end();
    }
  }

  /**
   * The brightest of the sampled pixels, kept once so no tick has to sweep for them again.
   *
   * At neutral exposure, since the candidates have to serve every position of the slider
   * and the middle of its range is the least biased place to pick them from.
   *
   * Then how many qualified, because that is what says whether the kept ones can be trusted.
   * `collect` keeps whichever arrive first and they arrive in dispatch order, so if more
   * qualify than fit, what is kept is the top of the frame rather than a spread of it - and a
   * blown sky can put hundreds of thousands over the threshold. The peak measured off that
   * prefix is the sky's, and `rolled_off` clamps every pixel to it, so genuine highlights
   * lower down the frame flatten onto the sky and the roll-off knee lands in the wrong place.
   * The renditions, which run these same two passes over a full sample, would not agree.
   *
   * So the shortcut is used only where it is exact: nothing overflowed, and the kept set is
   * every qualifying pixel rather than a sample of them. Otherwise every tick reads the frame,
   * which costs about a millisecond and is what this replaced.
   */
  private chooseCandidates(): void {
    const encoder = this.device.createCommandEncoder();
    this.writeUniform({ exposure: 1 });
    this.writeBalance(encoder);
    encoder.clearBuffer(this.histogram);
    encoder.clearBuffer(this.candidates, 0, 16);
    const [x, y] = this.sampledGroups;
    this.peakPass(encoder, [
      ['measure', this.peakMeasure, x, y],
      ['quantile', this.peakQuantile, 1, 1],
      ['collect', this.peakCollect, x, y],
    ]);

    const counted = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    encoder.copyBufferToBuffer(this.candidates, 0, counted, 0, 4);
    this.device.queue.submit([encoder.finish()]);

    // Off the submit rather than awaited, so the open does not wait on the GPU for a decision
    // whose safe answer is the one already in place. Ticks before it lands read the frame.
    void counted
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const above = new Uint32Array(counted.getMappedRange())[0] ?? 0;
        counted.unmap();
        this.useCandidates = above > 0 && above <= PEAK_CANDIDATES;
      })
      .catch(() => {
        // A device lost between here and there. Nothing to decide, and nothing to report:
        // whatever asked for a tick will find out from the tick.
      })
      .finally(() => counted.destroy());
  }

  private measurePeak(encoder: GPUCommandEncoder): void {
    encoder.clearBuffer(this.histogram);
    const [x, y] = this.sampledGroups;
    this.peakPass(encoder, [
      this.useCandidates
        ? // The candidates, not the frame: 16,384 pixels rather than a million.
          (['remeasure', this.peakRemeasure, Math.ceil(PEAK_CANDIDATES / 64), 1] as const)
        : (['measure', this.peakMeasure, x, y] as const),
      // One workgroup: the search is over bins, not pixels.
      ['quantile', this.peakQuantile, 1, 1],
    ]);
  }

  private draw(encoder: GPUCommandEncoder, region: Region): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
      timestampWrites: this.timer?.writes('draw'),
    });
    // The same ratio `covered` takes its level from: below two, the frame's own pixels are
    // what the taps want, and the pyramid does not hold them.
    const canvas = this.context.canvas;
    const ratio = Math.max(
      region.width / Math.max(canvas.width, 1),
      region.height / Math.max(canvas.height, 1),
    );
    pass.setPipeline(ratio < 2 ? this.drawFromFrame : this.drawFromPyramid);
    pass.setBindGroup(0, this.drawGroup);
    pass.draw(3);
    pass.end();
  }
}
