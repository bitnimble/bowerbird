// The tick, orchestrated.
//
// `Prepared` crosses once and becomes a texture that stays on the GPU; after that a slider
// move writes a uniform and submits dispatches, and nothing is uploaded, downloaded or
// encoded (`docs/raw-edit-gpu.md` §6). The decode, the camera fit, the lens warp and the
// denoise all happened natively before the bytes arrived, so a tick is the grade alone.

import { type PassMs, PassTimer } from './pass_timer';
import {
  FRAME,
  PEAK,
  PEAK_BINS,
  PEAK_CANDIDATES,
  PEAK_CONSTANTS,
  PEAK_SAMPLES,
  REDUCE,
  TICK_UNIFORM_FLOATS,
} from './shaders';

/** `Sample::from_f32` for `u16`: rounded, and held inside the range it has to fit. */
const clamp16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));

export interface ChromaPayload {
  nodes: number[];
  chromaCount: number;
  levelCount: number;
  chromaLow: number;
  chromaScale: number;
  levelScale: number;
}

export interface ColourPayload {
  curves: [number[], number[], number[]];
  matrix: [[number, number, number], [number, number, number], [number, number, number]];
  saturation: number;
  trustCeiling: number;
  chroma: ChromaPayload | null;
}

export interface PreparedHeader {
  width: number;
  height: number;
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
 * `float32-filterable` is the one that matters: the tone curve and the chroma map are `f32`
 * lookups the sampler interpolates, and without it neither is filterable and the pipeline
 * will not build. Every desktop adapter this has run on offers it.
 *
 * Thrown for rather than filtered out. Filtering it left the device built without it and
 * the failure to `createRenderPipeline`, which is a WebGPU validation error - asynchronous,
 * reported to an uncaptured-error handler nothing installs, and not an exception the open
 * can catch. So the open ran to the end, the reader was told `live`, and the canvas stayed
 * black with nothing anywhere saying why.
 *
 * `timestamp-query` really is optional: without it the readout loses its per-pass
 * milliseconds and the picture is identical.
 */
export function tickFeatures(adapter: GPUAdapter): GPUFeatureName[] {
  if (!adapter.features.has('float32-filterable')) {
    throw new Error(
      'this GPU cannot filter float textures (float32-filterable), which the tone curve and the camera match are',
    );
  }
  return (['float32-filterable', 'timestamp-query'] as GPUFeatureName[]).filter((feature) =>
    adapter.features.has(feature),
  );
}

/**
 * The limits a full-resolution frame needs, which are nothing like the defaults.
 *
 * `requestDevice` hands back the *default* limits however capable the adapter is, and the
 * defaults are sized for a web page rather than for a sensor: `maxTextureDimension2D` is
 * 8192 against the 9504 a 61MP frame is wide, and `maxBufferSize` is 256MB against the
 * 366MB that frame's levels take. Both failures are validation errors, which drop the
 * dispatches and read as a very fast tick rather than as a failure - this has cost a
 * morning twice.
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
  private readonly matrix: GPUBuffer;
  /** The frame as it arrived: interleaved RGB `u16`, three to a pixel. */
  private readonly frame: GPUBuffer;
  /** Half resolution and down. `lod` 0 is the frame; level L here is `lod` L + 1. */
  private readonly pyramid: GPUTexture;
  private readonly levels: number;
  private readonly curves: GPUTexture;
  private readonly chroma: GPUTexture;
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
    const pixels = this.width * this.height;
    this.rowStride = Math.max(1, Math.round(pixels / PEAK_SAMPLES));

    if (Math.max(this.width, this.height) > device.limits.maxTextureDimension2D) {
      throw new Error(
        `this GPU holds frames to ${device.limits.maxTextureDimension2D}px a side; this one is ${this.width}x${this.height}`,
      );
    }
    // The frame as it arrived: interleaved RGB `u16`, no fourth component and no second
    // copy to add one. At 61MP that is 361MB rather than 481.
    this.frame = device.createBuffer({
      size: Math.ceil((samples.byteLength + 3) / 4) * 4,
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

    const colour = header.colour;
    // A row per channel, which is how the shader picks one: `sample_curve` samples at the
    // row's own texel centre so the filter along the curve does not blend red into green.
    const bins = colour ? colour.curves[0].length : 1;
    this.curves = this.lookup([bins, 3], '2d', 'r32float', 4, [
      ...(colour?.curves.flat() ?? [0, 0, 0]),
    ]);
    // A 2x2 per node is exactly four components, and a node lattice is exactly a volume,
    // so `ChromaMap`'s trilinear is what a 3D texture does for free.
    const chroma = colour?.chroma;
    this.chroma = this.lookup(
      [chroma?.chromaCount ?? 1, chroma?.chromaCount ?? 1, chroma?.levelCount ?? 1],
      '3d',
      'rgba32float',
      16,
      chroma?.nodes ?? [0, 0, 0, 0],
    );
    this.lerp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    this.matrix = this.upload(
      new Float32Array(colour ? colour.matrix.flat() : [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    );
    const frame = device.createShaderModule({ code: FRAME, label: 'frame' });
    const peak = device.createShaderModule({ code: PEAK, label: 'peak' });

    // Explicit layouts rather than `auto`, because `auto` derives the layout from what an
    // entry point happens to reference: `fs` reads five of the seven bindings `FRAME`
    // declares, so its derived layout has five, and a bind group built for the shader as
    // written is then rejected. Two layouts over the one module instead, differing only in
    // the stage that sees them and in `counts`, which only `encode` writes.
    const bindings = (visibility: number) => ({
      colour: [
        { binding: 0, visibility, buffer: { type: 'uniform' as const } },
        { binding: 1, visibility, buffer: { type: 'read-only-storage' as const } },
        { binding: 2, visibility, texture: {} },
        { binding: 3, visibility, texture: { viewDimension: '3d' as const } },
        { binding: 4, visibility, buffer: { type: 'read-only-storage' as const } },
        { binding: 7, visibility, sampler: {} },
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

    const compute = (
      module: GPUShaderModule,
      entryPoint: string,
      layout: GPUBindGroupLayout,
      constants?: Record<string, number>,
    ) =>
      device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint, ...(constants != null && { constants }) },
      });

    // The peak's two lengths are its shader's overrides, so the buffers below and the
    // loops above cannot come to disagree about them.
    const onPeak = (entryPoint: string) =>
      compute(peak, entryPoint, this.peakLayout, PEAK_CONSTANTS);
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

    this.reduce();
    if (header.matched) this.chooseCandidates();
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
    this.writeUniform({ exposure: 2 ** ev, fromCandidates: true, region });

    if (this.header.matched) this.measurePeak(encoder);
    this.draw(encoder, region);

    this.timer?.resolve(encoder);
    this.device.queue.submit([encoder.finish()]);
  }

  /** The whole frame, which is what a fresh open shows. */
  get wholeFrame(): Region {
    return { x: 0, y: 0, width: this.width, height: this.height };
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
      this.writeUniform({ exposure: 2 ** ev, fromCandidates });
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
    const counts = this.device.createBuffer({
      size: pixels * 3 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    const staging = this.device.createBuffer({
      size: pixels * 3 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.encodePipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.encodeLayout,
        entries: [...this.displayEntries(), { binding: 6, resource: { buffer: counts } }],
      }),
    );
    const [x, y] = this.groups(this.width, this.height);
    pass.dispatchWorkgroups(x, y);
    pass.end();
    encoder.copyBufferToBuffer(counts, 0, staging, 0, staging.size);
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);

    const frame = Uint16Array.from(new Uint32Array(staging.getMappedRange()), clamp16);
    staging.unmap();
    staging.destroy();
    counts.destroy();
    return frame;
  }

  destroy(): void {
    this.timer?.destroy();
    for (const texture of [this.pyramid, this.curves, this.chroma]) texture.destroy();
    for (const buffer of [
      this.uniform,
      this.frame,
      this.histogram,
      this.peak,
      this.candidates,
      this.matrix,
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
    values: number[],
  ): GPUTexture {
    const texture = this.device.createTexture({
      size,
      dimension,
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture },
      new Float32Array(values),
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

  private writeUniform(
    over: { exposure?: number; fromCandidates?: boolean; region?: Region } = {},
  ): void {
    const header = this.header;
    const colour = header.colour;
    if (over.exposure != null) this.exposure = over.exposure;
    const values = new Float32Array(TICK_UNIFORM_FLOATS);
    const ints = new Uint32Array(values.buffer);
    ints[0] = this.width;
    ints[1] = this.height;
    values[2] = header.white;
    values[3] = header.peak;
    values[4] = header.grade.referenceWhiteNits;
    values[5] = header.grade.peakNits;
    values[6] = this.exposure;
    // 7 is `pad0`, which aligns the vectors below and is read by nothing.
    ints[8] = header.matched ? 1 : 0;
    values[9] = colour?.saturation ?? 1;
    ints[10] = colour?.chroma == null ? 0 : 1;
    ints[11] = colour ? colour.curves[0].length : 2;
    values[12] = colour?.trustCeiling ?? 1;
    ints[13] = colour?.chroma?.chromaCount ?? 2;
    ints[14] = colour?.chroma?.levelCount ?? 2;
    values[15] = colour?.chroma?.chromaLow ?? 0;
    values[16] = colour?.chroma?.chromaScale ?? 1;
    values[17] = colour?.chroma?.levelScale ?? 1;
    values[18] = SDR_WHITE_NITS;
    ints[19] = this.rowStride;
    ints[20] = this.width * Math.ceil(this.height / this.rowStride);
    ints[21] = over.fromCandidates ? 1 : 0;

    const region = over.region ?? this.wholeFrame;
    const canvas = this.context.canvas;
    values[22] = region.x;
    values[23] = region.y;
    values[24] = region.width;
    values[25] = region.height;
    values[26] = canvas.width;
    values[27] = canvas.height;
    // `lod` 0 is the frame itself, so the pyramid's levels are 1..levels.
    ints[28] = this.levels;
    this.device.queue.writeBuffer(this.uniform, 0, values);
  }

  private exposure = 1;

  private groups(x: number, y = 1): [number, number] {
    return [Math.ceil(x / 8), Math.ceil(y / 8)];
  }

  /** Everything the colour transform reads, whichever entry point is reading it. */
  private colourEntries(): GPUBindGroupEntry[] {
    return [
      { binding: 0, resource: { buffer: this.uniform } },
      { binding: 1, resource: { buffer: this.frame } },
      { binding: 2, resource: this.curves.createView() },
      { binding: 3, resource: this.chroma.createView() },
      { binding: 4, resource: { buffer: this.matrix } },
      { binding: 7, resource: this.lerp },
    ];
  }

  /** The above plus the scene peak, which everything but the pass that measures it reads. */
  private displayEntries(): GPUBindGroupEntry[] {
    return [
      ...this.colourEntries(),
      { binding: 5, resource: { buffer: this.peak } },
      { binding: 9, resource: this.pyramid.createView() },
    ];
  }

  /** The rows the peak samples, as a dispatch over about `PEAK_SAMPLES` pixels. */
  private get sampledGroups(): [number, number] {
    return [Math.ceil(this.width / 64), Math.ceil(this.height / this.rowStride)];
  }

  private peakPass(
    encoder: GPUCommandEncoder,
    passes: [string, GPUComputePipeline, number, number][],
  ): void {
    const entries: GPUBindGroupEntry[] = [
      ...this.colourEntries(),
      { binding: 5, resource: { buffer: this.histogram } },
      { binding: 6, resource: { buffer: this.peak } },
      { binding: 8, resource: { buffer: this.candidates } },
    ];
    // A pass each rather than several dispatches in one, so each reports its own time: a
    // dispatch over a million pixels and a dispatch over one workgroup are the same shape
    // from outside, and the difference is what the tick is being tuned on.
    for (const [label, pipeline, x, y] of passes) {
      const pass = encoder.beginComputePass({ timestampWrites: this.timer?.writes(label) });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device.createBindGroup({ layout: this.peakLayout, entries }));
      pass.dispatchWorkgroups(x, y);
      pass.end();
    }
  }

  /**
   * The brightest of the sampled pixels, kept once so no tick has to sweep for them again.
   *
   * At neutral exposure, since the candidates have to serve every position of the slider
   * and the middle of its range is the least biased place to pick them from.
   */
  private chooseCandidates(): void {
    const encoder = this.device.createCommandEncoder();
    this.writeUniform({ exposure: 1 });
    encoder.clearBuffer(this.histogram);
    encoder.clearBuffer(this.candidates, 0, 16);
    const [x, y] = this.sampledGroups;
    this.peakPass(encoder, [
      ['measure', this.peakMeasure, x, y],
      ['quantile', this.peakQuantile, 1, 1],
      ['collect', this.peakCollect, x, y],
    ]);
    this.device.queue.submit([encoder.finish()]);
  }

  private measurePeak(encoder: GPUCommandEncoder): void {
    encoder.clearBuffer(this.histogram);
    this.peakPass(encoder, [
      // The candidates, not the frame: 16,384 pixels rather than a million.
      ['remeasure', this.peakRemeasure, Math.ceil(PEAK_CANDIDATES / 64), 1],
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
    pass.setBindGroup(
      0,
      this.device.createBindGroup({ layout: this.drawLayout, entries: this.displayEntries() }),
    );
    pass.draw(3);
    pass.end();
  }
}
