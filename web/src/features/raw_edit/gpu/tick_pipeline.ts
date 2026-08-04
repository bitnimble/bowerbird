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

import { GRADE, PEAK, PEAK_BINS, PRESENT, TICK_UNIFORM_FLOATS } from './shaders';

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

export class TickPipeline {
  /**
   * The graded frame, PQ-coded, between the grade and the draw.
   *
   * One interleaved texture rather than three planes: the split existed for
   * `image::finish`, which works a plane at a time and now runs once at open instead.
   */
  private readonly graded: GPUTexture;
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
  private readonly source: GPUTexture;

  private readonly peakClear: GPUComputePipeline;
  private readonly peakMeasure: GPUComputePipeline;
  private readonly peakQuantile: GPUComputePipeline;
  private readonly gradePipeline: GPUComputePipeline;
  private readonly present: GPURenderPipeline;
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
    // COPY_SRC so the parity harness can read the graded frame back without a second
    // pipeline; the cost is a usage flag, and a wrong picture is otherwise invisible.
    this.graded = device.createTexture({
      size: [this.width, this.height],
      // f32 rather than f16: this is the frame parity is measured on, and half a
      // float costs 33 counts of 65535 where the whole point of the tick is that tone
      // and colour land exactly. The canvas it feeds is f16, where it does not matter.
      format: 'rgba32float',
      usage:
        GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
    });

    // A tick is the peak, the grade and the draw, so a handful is plenty; grown on demand
    // rather than guessed exactly, since being wrong costs an allocation.
    for (let i = 0; i < 8; i++) this.uniforms.push(this.newUniform());
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
    const grade = device.createShaderModule({ code: GRADE, label: 'grade' });
    const peak = device.createShaderModule({ code: PEAK, label: 'peak' });
    const present = device.createShaderModule({ code: PRESENT, label: 'present' });

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

    const gradeLayout = device.createBindGroupLayout({
      entries: [
        uniform,
        texture(1),
        readOnly(2),
        readOnly(3),
        readOnly(4),
        {
          binding: 5,
          visibility: COMPUTE,
          storageTexture: { access: 'write-only', format: 'rgba32float' },
        },
        readOnly(6),
      ],
    });
    this.peakLayout = device.createBindGroupLayout({
      entries: [uniform, texture(1), readOnly(2), readOnly(3), readOnly(4), writable(5), writable(6)],
    });
    this.presentLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
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
    this.present = device.createRenderPipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.presentLayout] }),
      vertex: { module: present, entryPoint: 'vs' },
      fragment: { module: present, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /** Grades at `ev` stops and puts the result on the canvas. One submit, no readback. */
  render(ev: number): void {
    const encoder = this.device.createCommandEncoder();
    this.uniformsUsed = 0;
    this.writeUniform({ exposure: 2 ** ev });

    if (this.header.matched) this.measurePeak(encoder);
    this.grade(encoder);
    this.draw(encoder);

    this.device.queue.submit([encoder.finish()]);
  }

  /**
   * The graded frame as the CPU would have left it, for the parity harness.
   *
   * Scaled back to the `u16` counts `encode_pq` wrote, which is the unit the fixture and
   * every other pin in this repo is written in.
   */
  async readFrame(): Promise<Uint16Array> {
    const pixels = this.width * this.height;
    // 256-byte row alignment, which a copy out of a texture requires and 8 bytes a texel
    // rarely satisfies on its own.
    const bytesPerRow = Math.ceil((this.width * 16) / 256) * 256;
    const staging = this.device.createBuffer({
      size: bytesPerRow * this.height,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const encoder = this.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture: this.graded },
      { buffer: staging, bytesPerRow, rowsPerImage: this.height },
      [this.width, this.height],
    );
    this.device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);

    const texels = new Float32Array(staging.getMappedRange());
    const frame = new Uint16Array(pixels * 3);
    const stride = bytesPerRow / 4;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const from = y * stride + x * 4;
        const to = (y * this.width + x) * 3;
        frame[to] = clamp16(texels[from]! * 65535);
        frame[to + 1] = clamp16(texels[from + 1]! * 65535);
        frame[to + 2] = clamp16(texels[from + 2]! * 65535);
      }
    }
    staging.unmap();
    staging.destroy();
    return frame;
  }

  destroy(): void {
    this.graded.destroy();
    this.source.destroy();
    for (const buffer of [...this.uniforms, this.histogram, this.peak, this.curves, this.chromaNodes, this.matrix]) {
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
          { binding: 5, resource: this.graded.createView() },
          { binding: 6, resource: { buffer: this.peak } },
        ],
      }),
    );
    const [x, y] = this.groups(this.width, this.height);
    pass.dispatchWorkgroups(x, y);
    pass.end();
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
          { binding: 1, resource: this.graded.createView() },
        ],
      }),
    );
    pass.draw(3);
    pass.end();
  }
}
