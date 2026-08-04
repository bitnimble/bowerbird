// The tick, orchestrated.
//
// `Prepared` crosses once and becomes a texture that stays on the GPU; after that a slider
// move writes a uniform and submits dispatches, and nothing is uploaded, downloaded or
// encoded (`docs/raw-edit-gpu.md` §6). There is no wasm on this path: the decode, the
// camera fit and the lens warp all happened natively before the bytes arrived.
//
// The stage order is `wasm::Editor::grade_from`'s, because it has to be: grade, PQ,
// `image::finish`, then the display transform. What has gone is the copy at the front (the
// source texture is never written) and the encode at the back (a canvas is not a file).

import {
  FINISH,
  FINISH_WGSL,
  GRADE,
  LUMA,
  PEAK,
  PEAK_BINS,
  PRESENT,
  SHARPEN,
  TICK_UNIFORM_FLOATS,
  withHalfPlanes,
} from './shaders';

/** `Sample::from_f32` for `u16`: rounded, and held inside the range it has to fit. */
const clamp16 = (v: number): number => Math.max(0, Math.min(65535, Math.round(v)));

/** IEEE 754 binary16 to a number, for reading a half-precision plane back. */
function half(bits: number): number {
  const sign = bits >> 15 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (fraction + 1024) * 2 ** (exponent - 25);
}

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
  sigma: number;
  defocusRed: number;
  defocusBlue: number;
}

/**
 * BT.2408 reference white, and the divisor an extended-range canvas needs.
 *
 * Measured rather than assumed (`docs/raw-edit-gpu.md` §7.1): sweeping this against a real
 * PQ AVIF of the same pixels, Chrome and Safari both match at 203. It is the browser's
 * constant, not `Grade::reference_white_nits`, which a library is free to move.
 */
const SDR_WHITE_NITS = 203;

/** Every plane the pipeline needs live at once, named so a swap reads as one. */
type PlaneName =
  | 'luma'
  | 'red'
  | 'blue'
  | 's0'
  | 's1'
  | 's2'
  | 's3'
  | 's4'
  | 's5'
  | 'extrema';

const PLANES: PlaneName[] = ['luma', 'red', 'blue', 's0', 's1', 's2', 's3', 's4', 's5'];

export class TickPipeline {
  private readonly planes = new Map<PlaneName, GPUBuffer>();
  /**
   * One uniform buffer per pass, not one reused across them.
   *
   * `queue.writeBuffer` takes effect before the command buffer it was recorded alongside
   * ever runs, so a single uniform written per stage would leave every stage reading the
   * last stage's radius. A ring costs 96 bytes a pass and keeps the tick to one submit.
   */
  private readonly uniforms: GPUBuffer[] = [];
  private uniformsUsed = 0;
  private current: GPUBuffer;
  private readonly histogram: GPUBuffer;
  private readonly peak: GPUBuffer;
  private readonly curves: GPUBuffer;
  private readonly chromaNodes: GPUBuffer;
  private readonly matrix: GPUBuffer;
  private readonly taps: GPUBuffer;
  private readonly source: GPUTexture;

  private readonly peakClear: GPUComputePipeline;
  private readonly peakMeasure: GPUComputePipeline;
  private readonly peakQuantile: GPUComputePipeline;
  private readonly gradePipeline: GPUComputePipeline;
  private readonly plane: Record<string, GPUComputePipeline> = {};
  private readonly sharpen: Record<string, GPUComputePipeline> = {};
  private readonly present: GPURenderPipeline;
  private readonly planeLayout: GPUBindGroupLayout;
  private readonly peakLayout: GPUBindGroupLayout;
  private readonly gradeLayout: GPUBindGroupLayout;
  private readonly presentLayout: GPUBindGroupLayout;

  private readonly width: number;
  private readonly height: number;

  constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly header: PreparedHeader,
    samples: Uint16Array,
    /** Diagnostic: store the working planes at half precision ('withHalfPlanes'). */
    readonly halfPlanes = false,
  ) {
    this.width = header.width;
    this.height = header.height;
    const pixels = this.width * this.height;

    this.source = device.createTexture({
      size: [this.width, this.height],
      format: 'rgba16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    // Padded to four components here rather than in the shader: a texture takes RGBA and
    // the frame is RGB, and doing it on the way in costs one pass over a buffer that is
    // about to be uploaded anyway.
    const rgba = new Uint16Array(pixels * 4);
    for (let i = 0, o = 0; o < rgba.length; i += 3, o += 4) {
      rgba[o] = samples[i]!;
      rgba[o + 1] = samples[i + 1]!;
      rgba[o + 2] = samples[i + 2]!;
      rgba[o + 3] = 65535;
    }
    device.queue.writeTexture(
      { texture: this.source },
      rgba,
      { bytesPerRow: this.width * 8, rowsPerImage: this.height },
      [this.width, this.height],
    );

    // COPY_SRC on every plane so the parity harness can read one back without a second
    // pipeline; the cost is a usage flag, and a wrong picture is otherwise invisible.
    const storage = (
      length: number,
      usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    ) => device.createBuffer({ size: length * 4, usage });
    // Planes narrow with the storage format; the histogram, the curves and the uniforms do
    // not, since none of them is walked per pixel.
    const bytes = halfPlanes ? 2 : 4;
    const plane = (length: number) =>
      device.createBuffer({
        size: length * bytes,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
      });
    for (const name of PLANES) this.planes.set(name, plane(pixels));
    // Two values a pixel, since the horizontal extrema sweep carries a low and a high.
    this.planes.set('extrema', plane(pixels * 2));

    // Sized for the deconvolution, which is the stage with the most passes: ten iterations
    // of six, plus the guided filters ahead of it. Grown on demand rather than guessed
    // exactly, since being wrong costs an allocation and never a wrong picture.
    for (let i = 0; i < 128; i++) this.uniforms.push(this.newUniform());
    this.current = this.uniforms[0]!;
    this.histogram = storage(PEAK_BINS);
    this.peak = storage(4);

    const colour = header.colour;
    const curves = colour ? [...colour.curves[0], ...colour.curves[1], ...colour.curves[2]] : [0];
    this.curves = this.upload(new Float32Array(curves));
    this.chromaNodes = this.upload(new Float32Array(colour?.chroma?.nodes ?? [0, 0, 0, 0]));
    this.matrix = this.upload(
      new Float32Array(colour ? colour.matrix.flat() : [1, 0, 0, 0, 1, 0, 0, 0, 1]),
    );
    this.taps = this.upload(new Float32Array(gaussianTaps()));

    // The grade writes the planes and the present reads them, so both follow the format.
    const half = (code: string) => (halfPlanes ? withHalfPlanes(code) : code);
    const grade = device.createShaderModule({ code: half(GRADE), label: 'grade' });
    const peak = device.createShaderModule({ code: PEAK, label: 'peak' });
    const finish = device.createShaderModule({ code: half(FINISH_WGSL), label: 'finish' });
    const sharpen = device.createShaderModule({ code: half(SHARPEN), label: 'sharpen' });
    const present = device.createShaderModule({ code: half(PRESENT), label: 'present' });

    // Explicit layouts rather than `auto`, because `auto` derives the layout from what an
    // entry point happens to reference: `copy` reads two of the five bindings the plane
    // shader declares, so its derived layout has three, and a bind group built for the
    // shader as written is then rejected. One layout per module, shared by every entry
    // point in it, is what makes the ops interchangeable at the call site.
    const COMPUTE = GPUShaderStage.COMPUTE;
    const uniform = { binding: 0, visibility: COMPUTE, buffer: { type: 'uniform' as const } };
    const readOnly = (binding: number) => ({
      binding,
      visibility: COMPUTE,
      buffer: { type: 'read-only-storage' as const },
    });
    const writable = (binding: number) => ({
      binding,
      visibility: COMPUTE,
      buffer: { type: 'storage' as const },
    });
    const texture = (binding: number) => ({
      binding,
      visibility: COMPUTE,
      texture: { sampleType: 'uint' as const },
    });

    this.planeLayout = device.createBindGroupLayout({
      entries: [uniform, readOnly(1), writable(2), readOnly(3), readOnly(4)],
    });
    const gradeLayout = device.createBindGroupLayout({
      entries: [
        uniform,
        texture(1),
        readOnly(2),
        readOnly(3),
        readOnly(4),
        writable(5),
        writable(6),
        writable(7),
        readOnly(8),
      ],
    });
    this.peakLayout = device.createBindGroupLayout({
      entries: [uniform, texture(1), readOnly(2), readOnly(3), readOnly(4), writable(5), writable(6)],
    });
    this.presentLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });

    const compute = (module: GPUShaderModule, entryPoint: string, layout: GPUBindGroupLayout) =>
      device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module, entryPoint },
      });

    this.peakClear = compute(peak, 'clear', this.peakLayout);
    this.peakMeasure = compute(peak, 'measure', this.peakLayout);
    this.peakQuantile = compute(peak, 'quantile', this.peakLayout);
    this.gradeLayout = gradeLayout;
    this.gradePipeline = compute(grade, 'grade', gradeLayout);
    for (const entry of [
      'scan_h',
      'scan_v',
      'window_h',
      'window_v',
      'square',
      'multiply',
      'subtract_product',
      'slope',
      'intercept',
      'combine',
      'copy',
      'blend_limited',
      'blend_toward',
      'laplacian',
      'defringe',
      'defringe_blue',
    ]) {
      this.plane[entry] = compute(finish, entry, this.planeLayout);
    }
    for (const entry of [
      'convolve_h',
      'convolve_v',
      'ratio',
      'scale_by',
      'floor_at',
      'extrema_h',
      'extrema_v_clamp',
    ]) {
      this.sharpen[entry] = compute(sharpen, entry, this.planeLayout);
    }
    this.present = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.presentLayout] }),
      vertex: { module: present, entryPoint: 'vs' },
      fragment: { module: present, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /**
   * Grades at `ev` stops and puts the result on the canvas. One submit, no readback.
   *
   * `skipFinish` is the parity harness's, not a mode: it is how a failure says whether the
   * grade or the denoise drifted, and the two are held to different tolerances (§6.3).
   */
  render(ev: number, skipFinish = false): void {
    const encoder = this.device.createCommandEncoder();
    this.uniformsUsed = 0;
    this.cost.dispatches = 0;
    this.cost.planeTouches = 0;
    this.writeUniform({ exposure: 2 ** ev });

    if (this.header.matched) this.measurePeak(encoder);
    this.grade(encoder);
    if (!skipFinish) this.finish(encoder);
    this.draw(encoder);

    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * The three planes as the CPU would have left them, for the parity harness.
   *
   * Recombined here rather than in a shader so the comparison is against
   * `image::recombine`'s arithmetic and not against a second copy of it.
   */
  async readFrame(): Promise<Uint16Array> {
    const pixels = this.width * this.height;
    const read = async (name: PlaneName): Promise<Float32Array> => {
      const bytes = pixels * (this.halfPlanes ? 2 : 4);
      const staging = this.device.createBuffer({
        size: bytes,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.buffer(name), 0, staging, 0, bytes);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const range = staging.getMappedRange();
      const copy = this.halfPlanes
        ? Float32Array.from(new Uint16Array(range), half)
        : new Float32Array(range).slice();
      staging.unmap();
      staging.destroy();
      return copy;
    };

    const [luma, red, blue] = await Promise.all([read('luma'), read('red'), read('blue')]);
    const frame = new Uint16Array(pixels * 3);
    for (let i = 0; i < pixels; i++) {
      const l = luma[i]!;
      const dr = red[i]!;
      const db = blue[i]!;
      const dg = -(LUMA[0] * dr + LUMA[2] * db) / LUMA[1];
      frame[i * 3] = clamp16((l + dr) * 65535);
      frame[i * 3 + 1] = clamp16((l + dg) * 65535);
      frame[i * 3 + 2] = clamp16((l + db) * 65535);
    }
    return frame;
  }

  destroy(): void {
    for (const buffer of this.planes.values()) buffer.destroy();
    this.source.destroy();
    for (const buffer of [...this.uniforms, this.histogram, this.peak, this.curves, this.chromaNodes, this.matrix, this.taps]) {
      buffer.destroy();
    }
  }

  private upload(data: Float32Array<ArrayBuffer>): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: Math.max(data.byteLength, 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private buffer(name: PlaneName): GPUBuffer {
    const found = this.planes.get(name);
    if (found == null) throw new Error(`no plane named ${name}`);
    return found;
  }

  /**
   * The one uniform every pass reads.
   *
   * Written per pass rather than per tick because `radius`, `eps` and `limit` change
   * between stages, and a second uniform buffer per stage would be more state to keep in
   * step than one write of 96 bytes costs.
   */
  private newUniform(): GPUBuffer {
    return this.device.createBuffer({
      size: TICK_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  private writeUniform(over: { exposure?: number; radius?: number; eps?: number; limit?: number } = {}): void {
    const header = this.header;
    const colour = header.colour;
    if (over.exposure != null) this.exposure = over.exposure;
    if (this.uniformsUsed >= this.uniforms.length) this.uniforms.push(this.newUniform());
    this.current = this.uniforms[this.uniformsUsed++]!;
    const values = new Float32Array(TICK_UNIFORM_FLOATS);
    const ints = new Uint32Array(values.buffer);
    ints[0] = this.width;
    ints[1] = this.height;
    values[2] = header.white;
    values[3] = header.peak;
    values[4] = header.grade.referenceWhiteNits;
    values[5] = header.grade.peakNits;
    values[6] = this.exposure;
    values[7] = (colour?.trustCeiling ?? 1) * header.white;
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
    ints[19] = over.radius ?? 0;
    values[20] = over.eps ?? 0;
    values[21] = over.limit ?? 0;
    values[22] = header.defocusRed;
    values[23] = header.defocusBlue;
    this.device.queue.writeBuffer(this.current, 0, values);
  }

  private exposure = 1;

  private groups(x: number, y = 1): [number, number] {
    return [Math.ceil(x / 8), Math.ceil(y / 8)];
  }

  private measurePeak(encoder: GPUCommandEncoder): void {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.current } },
      { binding: 1, resource: this.source.createView() },
      { binding: 2, resource: { buffer: this.curves } },
      { binding: 3, resource: { buffer: this.chromaNodes } },
      { binding: 4, resource: { buffer: this.matrix } },
      { binding: 5, resource: { buffer: this.histogram } },
      { binding: 6, resource: { buffer: this.peak } },
    ];
    const pass = encoder.beginComputePass();
    for (const [pipeline, x, y] of [
      [this.peakClear, Math.ceil(PEAK_BINS / 64), 1],
      [this.peakMeasure, ...this.groups(this.width, this.height)],
      [this.peakQuantile, 1, 1],
    ] as [GPUComputePipeline, number, number][]) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.device.createBindGroup({ layout: this.peakLayout, entries }));
      pass.dispatchWorkgroups(x, y);
    }
    pass.end();
  }

  private grade(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.gradePipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.gradeLayout,
        entries: [
          { binding: 0, resource: { buffer: this.current } },
          { binding: 1, resource: this.source.createView() },
          { binding: 2, resource: { buffer: this.curves } },
          { binding: 3, resource: { buffer: this.chromaNodes } },
          { binding: 4, resource: { buffer: this.matrix } },
          { binding: 5, resource: { buffer: this.buffer('luma') } },
          { binding: 6, resource: { buffer: this.buffer('red') } },
          { binding: 7, resource: { buffer: this.buffer('blue') } },
          { binding: 8, resource: { buffer: this.peak } },
        ],
      }),
    );
    const [x, y] = this.groups(this.width, this.height);
    pass.dispatchWorkgroups(x, y);
    pass.end();
  }

  /** One plane-algebra dispatch: `dst = f(src, aux0, aux1)`. */
  /**
   * Dispatches in the last tick, and the plane reads and writes they made.
   *
   * The cost model in one number. A plane is 40MB at 9.9MP, and the guided filter walks
   * one several times per box mean, so what looks like "a 40MB frame" is gigabytes of
   * traffic by the time `finish` has run. Counted rather than reasoned about, because the
   * reasoning is what was wrong the first time.
   */
  readonly cost = { dispatches: 0, planeTouches: 0 };

  private op(
    encoder: GPUCommandEncoder,
    entry: string,
    src: PlaneName,
    dst: PlaneName,
    aux0: PlaneName = src,
    aux1: PlaneName = src,
    dispatch?: [number, number],
  ): void {
    const pipeline = this.plane[entry] ?? this.sharpen[entry];
    if (pipeline == null) throw new Error(`no pipeline named ${entry}`);
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.planeLayout,
        entries: [
          { binding: 0, resource: { buffer: this.current } },
          { binding: 1, resource: { buffer: this.buffer(src) } },
          { binding: 2, resource: { buffer: this.buffer(dst) } },
          { binding: 3, resource: { buffer: this.buffer(aux0) } },
          { binding: 4, resource: { buffer: this.buffer(aux1) } },
        ],
      }),
    );
    const [x, y] = dispatch ?? this.groups(this.width, this.height);
    pass.dispatchWorkgroups(x, y);
    pass.end();
    // One write, plus a read for each distinct plane bound. Aux defaults to `src`, so a
    // one-input kernel counts two touches rather than four.
    this.cost.dispatches += 1;
    this.cost.planeTouches += 1 + new Set([src, aux0, aux1]).size;
  }

  /** The sharpen shader's bindings differ (taps and the observed plane), so it has its own. */
  private sharpenOp(
    encoder: GPUCommandEncoder,
    entry: string,
    src: PlaneName,
    dst: PlaneName,
    observed: PlaneName,
  ): void {
    const pipeline = this.sharpen[entry];
    if (pipeline == null) throw new Error(`no sharpen pipeline named ${entry}`);
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.planeLayout,
        entries: [
          { binding: 0, resource: { buffer: this.current } },
          { binding: 1, resource: { buffer: this.buffer(src) } },
          { binding: 2, resource: { buffer: this.buffer(dst) } },
          { binding: 3, resource: { buffer: this.taps } },
          { binding: 4, resource: { buffer: this.buffer(observed) } },
        ],
      }),
    );
    const [x, y] = this.groups(this.width, this.height);
    pass.dispatchWorkgroups(x, y);
    pass.end();
    this.cost.dispatches += 1;
    this.cost.planeTouches += 1 + new Set([src, observed]).size;
  }

  /**
   * `image::box_mean`, separably: a prefix sum along each axis and a difference across it.
   *
   * Four dispatches through the same two planes the sliding version used, so the call
   * sites are unchanged: the scan lands in `scratch`, the window reads it into `dst`, and
   * the vertical pair does the same the other way round. `src` is only read by the first
   * dispatch, so a caller passing `src === dst` is safe.
   */
  private boxMean(encoder: GPUCommandEncoder, src: PlaneName, dst: PlaneName, scratch: PlaneName, radius: number): void {
    this.writeUniform({ radius });
    this.op(encoder, 'scan_h', src, scratch, src, src, [this.height, 1]);
    this.op(encoder, 'window_h', scratch, dst);
    this.op(encoder, 'scan_v', dst, scratch, dst, dst, [this.width, 1]);
    this.op(encoder, 'window_v', scratch, dst);
  }

  /**
   * `image::finish`, whole-frame.
   *
   * The plane names carry the CPU's variables: `luma`, `red` and `blue` are the frame,
   * and `s0`..`s5` are what the Rust allocates and drops per stage. No strips, no halo and
   * no carry rows, because the reason for them was a CPU memory budget rather than the
   * arithmetic.
   */
  private finish(encoder: GPUCommandEncoder): void {
    const { strengths, sigma } = this.header;
    const chromaRadii = FINISH.chromaRadii.map((base) =>
      Math.max(Math.round(base * strengths.chroma), 1),
    ) as [number, number];

    if (this.header.defocusRed !== 0 || this.header.defocusBlue !== 0) {
      this.writeUniform();
      this.op(encoder, 'laplacian', 'luma', 's0');
      this.op(encoder, 'defringe', 's0', 'red');
      this.op(encoder, 'defringe_blue', 's0', 'blue');
    }

    if (strengths.luma > 0) {
      const eps = (FINISH.lumaSigmas * sigma) ** 2;
      this.guideStats(encoder, 'luma', FINISH.lumaRadius);
      // Self-guided: the input's mean *is* the guide's mean and the covariance *is* the
      // variance, which is four of the six box means already in hand.
      this.guidedWith(encoder, 'luma', 's0', 's1', 's0', 's1', FINISH.lumaRadius, eps, 'luma');
    }

    if (strengths.chroma > 0) {
      this.guideStats(encoder, 'luma', chromaRadii[0]);
      this.guided(encoder, 'red', chromaRadii[0], FINISH.denoiseEps, 'red');
      this.guided(encoder, 'blue', chromaRadii[0], FINISH.denoiseEps, 'blue');

      this.guideStats(encoder, 'luma', chromaRadii[1]);
      const limit = FINISH.chromaCoarseLimit * strengths.chroma;
      for (const channel of ['red', 'blue'] as const) {
        this.guided(encoder, channel, chromaRadii[1], FINISH.denoiseEps, 's5');
        this.writeUniform({ limit });
        this.op(encoder, 'blend_limited', 's5', channel);
      }
    }

    if (strengths.sharpen > 0) {
      this.deconvolve(encoder);
      this.writeUniform({ limit: Math.min(strengths.sharpen, 1) });
      this.op(encoder, 'blend_toward', 's2', 'luma');
    }
  }

  /** `image::guide_stats`: the guide's mean into `s0` and its variance into `s1`. */
  private guideStats(encoder: GPUCommandEncoder, guide: PlaneName, radius: number): void {
    this.boxMean(encoder, guide, 's0', 's4', radius);
    this.op(encoder, 'square', guide, 's2');
    this.boxMean(encoder, 's2', 's3', 's4', radius);
    this.op(encoder, 'subtract_product', 's3', 's1', 's0', 's0');
  }

  /**
   * `image::guided`, with the guide's statistics already in `s0` (mean) and `s1`
   * (variance). The mean of the input lands in `s2` and the covariance in `s3`.
   */
  private guided(
    encoder: GPUCommandEncoder,
    input: PlaneName,
    radius: number,
    eps: number,
    out: PlaneName,
  ): void {
    this.boxMean(encoder, input, 's2', 's4', radius);
    this.op(encoder, 'multiply', 'luma', 's3', input, input);
    this.boxMean(encoder, 's3', 's4', 's5', radius);
    this.op(encoder, 'subtract_product', 's4', 's3', 's0', 's2');
    this.guidedWith(encoder, 'luma', 's0', 's1', 's2', 's3', radius, eps, out);
  }

  /**
   * `image::guided_with`: the slope, the intercept, their means, and the fit averaged back
   * out. `mean` and `variance` are the guide's; `meanInput` and `covariance` the input's.
   */
  private guidedWith(
    encoder: GPUCommandEncoder,
    guide: PlaneName,
    mean: PlaneName,
    variance: PlaneName,
    meanInput: PlaneName,
    covariance: PlaneName,
    radius: number,
    eps: number,
    out: PlaneName,
  ): void {
    this.writeUniform({ eps });
    this.op(encoder, 'slope', covariance, 's4', variance);
    this.op(encoder, 'intercept', meanInput, 's5', 's4', mean);
    this.boxMean(encoder, 's4', 's4', 's2', radius);
    this.boxMean(encoder, 's5', 's5', 's2', radius);
    // Straight into `out` where nothing else in the dispatch is reading it: one buffer
    // cannot be both a read and a read_write binding at once. That rules out the guide,
    // which `out` is for the self-guided luma denoise, and the two scratch planes this
    // function is holding its own fit in. The chroma passes guide red and blue by luma and
    // land on neither, so they skip the bounce - worth having, since a whole-frame copy is
    // two more passes over 40MB and this runs six times a tick.
    const aliased = out === guide || out === 's4' || out === 's5';
    this.op(encoder, 'combine', 's4', aliased ? 's3' : out, guide, 's5');
    if (aliased) this.op(encoder, 'copy', 's3', out);
  }

  /**
   * `image::deconvolve`: Richardson-Lucy against a Gaussian point spread, then the
   * anti-ringing clamp. The observed plane is the luma as `finish` found it; the estimate
   * lands in `s2`.
   */
  private deconvolve(encoder: GPUCommandEncoder): void {
    this.writeUniform({ radius: FINISH.deconvolveRadius });
    this.sharpenOp(encoder, 'floor_at', 'luma', 's2', 'luma');
    for (let i = 0; i < FINISH.deconvolveIterations; i++) {
      this.sharpenOp(encoder, 'convolve_h', 's2', 's3', 'luma');
      this.sharpenOp(encoder, 'convolve_v', 's3', 's4', 'luma');
      this.sharpenOp(encoder, 'ratio', 's4', 's3', 'luma');
      this.sharpenOp(encoder, 'convolve_h', 's3', 's4', 'luma');
      this.sharpenOp(encoder, 'convolve_v', 's4', 's5', 'luma');
      this.sharpenOp(encoder, 'scale_by', 's5', 's2', 'luma');
    }
    // The clamp reads a window of the *observed* plane, so its radius is the point
    // spread's reach rather than the estimate's.
    this.sharpenOp(encoder, 'extrema_h', 'luma', 'extrema', 'luma');
    this.sharpenOp(encoder, 'extrema_v_clamp', 'extrema', 's2', 'luma');
  }

  private draw(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(this.present);
    pass.setBindGroup(
      0,
      this.device.createBindGroup({
        layout: this.presentLayout,
        entries: [
          { binding: 0, resource: { buffer: this.current } },
          { binding: 1, resource: { buffer: this.buffer('luma') } },
          { binding: 2, resource: { buffer: this.buffer('red') } },
          { binding: 3, resource: { buffer: this.buffer('blue') } },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
  }
}

/** `image::gaussian`, normalised over the whole symmetric kernel. */
function gaussianTaps(): number[] {
  const { deconvolveSigma: sigma, deconvolveRadius: radius } = FINISH;
  const taps = Array.from({ length: radius + 1 }, (_, d) => Math.exp(-(d * d) / (2 * sigma * sigma)));
  const sum = taps[0]! + 2 * taps.slice(1).reduce((a, b) => a + b, 0);
  return taps.map((t) => t / sum);
}
