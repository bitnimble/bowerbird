// Painting a decoded frame through WebGPU, which is the surface this app already shows HDR
// on: `rgba16float` with `toneMapping: extended` is what the editor opens
// (`raw_edit_presenter.attach`, DESIGN §7), and what lets a value sit above SDR white rather
// than being mapped back down to it. It runs on the GPU thread (`gpu_worker.ts`), with the
// module's own device, on canvases the page handed over (`stage_canvas.ts`).
//
// **An HDR frame is decoded here, not imported.** Every way of handing an encoded picture to
// WebGPU converts it into the colour space asked for, and the only ones on offer - `srgb` and
// `display-p3` - are SDR. Measured against this library: a PQ render sampled through
// `importExternalTexture` peaks at 0.81, copied through `copyExternalImageToTexture` into a
// float16 texture it peaks at 0.71, and *neither has a single sample above one*. The headroom
// is gone before any shader sees it, which is why an imported HDR rendition can only ever
// come out flat.
//
// So a PQ frame's planes are uploaded as they are - luma and chroma straight off `copyTo`, at
// whatever depth the file holds - and this does the work an import would otherwise have done
// wrong: limited-range BT.2020 YUV to RGB, the PQ curve to nits, nits against SDR white, and
// the primaries onto the canvas's. That is the same shape as the editor's own path, which also
// never imports a picture: it computes one.
//
// Everything else - a camera JPEG, an SDR rendition - still goes through the import, which is
// asked for the canvas's own colour space and hands the value over on the canvas's own curve.
// That leaves nothing to do to it: the fragment shader there is a copy.

import IMPORT_WGSL from '../generated/stage_import.wgsl?raw';
import PLANAR_WGSL from '../generated/stage.wgsl?raw';
import { planarLayout } from './planar_layout';
import type { RenderingIntent } from '../../../../../src/schemas/rendering_intent';
import type { Painted, StageAsk } from '../../../gpu/gpu_protocol';

/**
 * Where SDR white sits, in nits (ITU-R BT.2408).
 *
 * PQ is absolute: its codes name luminances rather than a fraction of a display's, so
 * something has to say which luminance the surface's 1.0 means. 203 is not a guess - it is
 * the same constant the renderer writes its own uniform with, measured there against Chrome
 * and Safari showing a real PQ AVIF (`gpu.rs`, `docs/raw-edit-gpu.md` §7.1).
 */
export const SDR_WHITE_NITS = 203;

/** `Colour.proof` in `stage.slang`: one more than the intent's number in `gamut_map.slang`. */
const PROOF_INTENT: Record<RenderingIntent, number> = { perceptual: 1, relativeColorimetric: 2 };

/**
 * The imported pipeline's fragment, which is the one thing `slang/` cannot say.
 *
 * `texture_external` is WebGPU's own type for a video frame and Slang has no name for it, so this
 * is appended to `stage_import.slang`'s compiled vertex rather than compiled with it. It is safe
 * to have here because it carries no arithmetic: the import has already converted into the
 * canvas's primaries and left the value on the canvas's own curve, and nothing is above white to
 * roll off because the import is what took the headroom away. Any transform applied here would be
 * a second one on top of a picture that was already finished.
 *
 * The region is where in the frame this canvas is, as an offset and a span: the whole of it when
 * the picture is fitted, and the part a reader has zoomed into otherwise. Sampled rather than
 * cropped on the way in, because the import carries the frame's own orientation and a rect in
 * coded pixels would not.
 */
const IMPORTED = `
${IMPORT_WGSL}

@group(0) @binding(0) var frameSampler: sampler;
@group(0) @binding(1) var frame: texture_external;
@group(0) @binding(2) var<uniform> region: vec4f;

struct Sampled {
  @location(0) uv: vec2f,
};

@fragment fn imported(drawn: Sampled) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(frame, frameSampler, region.xy + drawn.uv * region.zw);
}
`;

/** A part of a frame, in its displayed pixels. */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Drawing {
  device: GPUDevice;
  imported: GPURenderPipeline;
  planar: GPURenderPipeline;
  /** `planar` again with the mask binding, blended rather than clearing - `paintMasked`'s alone. */
  planarMasked: GPURenderPipeline;
  sampler: GPUSampler;
  colour: GPUBuffer;
  region: GPUBuffer;
}

let drawing: Drawing | null = null;

// Exported for the one test that can tell a masked pipeline from a plain one without an adapter.
export function pipelinesFor(device: GPUDevice): Drawing {
  if (drawing?.device === device) return drawing;
  const pipeline = (code: string, fragment: string, target?: GPUColorTargetState): GPURenderPipeline => {
    const module = device.createShaderModule({ code });
    return device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vertex' },
      fragment: { module, entryPoint: fragment, targets: [target ?? { format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    });
  };
  drawing = {
    device,
    colour: device.createBuffer({ size: COLOUR_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    region: device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    imported: pipeline(IMPORTED, 'imported'),
    planar: pipeline(PLANAR_WGSL, 'planar'),
    // Premultiplied source over what is already there: the fragment writes the picture times its
    // own alpha, so a pixel the mask leaves out contributes nothing rather than a black fringe.
    planarMasked: pipeline(PLANAR_WGSL, 'planar_masked', {
      format: 'rgba16float',
      blend: {
        color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    }),
    sampler: device.createSampler({ magFilter: 'linear', minFilter: 'linear' }),
  };
  return drawing;
}

/**
 * `region` grown outward to whole chroma samples, inside `frame`: `copyTo` throws on a rect that
 * starts or ends between two, which is every odd coordinate of a 4:2:0 frame.
 */
export function onChromaGrid(region: Region, chroma: number, frame: Region): Region {
  const step = Math.round(1 / chroma);
  const x0 = Math.floor(region.x / step) * step;
  const y0 = Math.floor(region.y / step) * step;
  const x1 = Math.min(frame.width, Math.ceil((region.x + region.width) / step) * step);
  const y1 = Math.min(frame.height, Math.ceil((region.y + region.height) / step) * step);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export function storedRegion(region: Region, rotation: 0 | 90 | 180 | 270, width: number, height: number): Region {
  switch (rotation) {
    case 90:
      return { x: region.y, y: height - region.x - region.width, width: region.height, height: region.width };
    case 180:
      return { x: width - region.x - region.width, y: height - region.y - region.height, width: region.width, height: region.height };
    case 270:
      return { x: width - region.y - region.height, y: region.x, width: region.height, height: region.width };
    default:
      return region;
  }
}

export async function planesOf(
  device: GPUDevice,
  frame: VideoFrame,
  region: Region,
  chroma: number,
): Promise<GPUTexture[]> {
  // Only the part being drawn is copied out, which is what makes zooming to a photograph's
  // own pixels cost the screen rather than the file: a sixty-megapixel frame taken whole is
  // ninety megabytes a pan.
  const rect = { x: region.x, y: region.y, width: region.width, height: region.height };
  const buffer = new Uint8Array(frame.allocationSize({ rect }));
  const planes = await frame.copyTo(buffer, { rect });
  return planes.slice(0, 3).map((plane, at) => {
    const span = at === 0 ? 1 : chroma;
    const width = Math.ceil(region.width * span);
    const height = Math.ceil(region.height * span);
    const texture = device.createTexture({
      size: [width, height],
      format: 'r16uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture(
      { texture },
      buffer.subarray(plane.offset, plane.offset + plane.stride * height),
      { bytesPerRow: plane.stride, rowsPerImage: height },
      { width, height },
    );
    return texture;
  });
}

type Paint = Extract<StageAsk, { kind: 'paint' }>;
type PaintMasked = Extract<StageAsk, { kind: 'paintMasked' }>;

/**
 * The page's canvases, held here once handed over, and every paint onto them.
 *
 * `device` is null where the browser has no WebGPU, and every paint then takes the 2D path.
 */
export class StagePainter {
  private readonly canvases = new Map<number, OffscreenCanvas>();
  /**
   * Set the first time a draw fails after the context was taken, which is a WebGPU this
   * browser advertises and cannot complete - Gecko's, where `importExternalTexture` is
   * missing behind a `navigator.gpu` that answers. One canvas is already spent when that is
   * found out; every later frame takes the 2D path instead of spending another.
   */
  private declined = false;

  constructor(private readonly device: GPUDevice | null) {}

  async answer(ask: StageAsk): Promise<Painted | null> {
    if (ask.kind === 'releaseCanvas') {
      this.canvases.delete(ask.canvas);
      return null;
    }
    // The frames arrive as clones of the page's, sharing its decode, and each is closed here once
    // drawn: an open clone holds the whole decoded frame for as long as it lives.
    const pictures = ask.kind === 'paint' ? [ask.picture] : [ask.base, ...ask.layers.map((layer) => layer.picture)];
    const masks = ask.kind === 'paint' ? [] : ask.layers.map((layer) => layer.mask);
    try {
      const canvas = this.sized(ask);
      return ask.kind === 'paint' ? await this.paint(canvas, ask) : await this.paintMasked(canvas, ask);
    } finally {
      for (const picture of [...pictures, ...masks]) picture.close();
    }
  }

  private sized(ask: Paint | PaintMasked): OffscreenCanvas {
    if (ask.handed != null) this.canvases.set(ask.canvas, ask.handed);
    const canvas = this.canvases.get(ask.canvas);
    if (canvas == null) throw new Error('this canvas was never handed over');
    if (canvas.width !== ask.width || canvas.height !== ask.height) {
      canvas.width = ask.width;
      canvas.height = ask.height;
    }
    return canvas;
  }

  /**
   * A frame, or `region` of it, drawn at the widest range the browser gives.
   *
   * **Asked for on every frame, not only the HDR ones.** A rendition built HDR carries values
   * above SDR white, and an eight-bit `srgb` surface clamps them on the way in. Asking for the
   * wide surface unconditionally is what keeps one drawing path rather than a canvas for one
   * kind of file and an `<img>` for the other: SDR values occupy nought to one either way, so
   * nothing about an ordinary camera JPEG changes.
   */
  private async paint(canvas: OffscreenCanvas, ask: Paint): Promise<Painted> {
    const extended = await this.paintExtended(canvas, ask);
    if (extended !== 'declined') return extended;
    // Otherwise plain and unconfigured, which is what a machine with no WebGPU shows: no colour
    // space asked for is no colour space converted to, so an SDR photograph comes out as the
    // `<img>` drew it, and the browser tone maps an HDR rendition on the way in rather than
    // clipping it - measured on a 1500-nit render, where a clip would blow the 2.9% of samples
    // above SDR white and this blows 0.04%.
    const flat = canvas.getContext('2d');
    // Null once the canvas has been configured for WebGPU, because a canvas holds one kind of
    // context for its whole life. Reported rather than skipped: `drawImage` silently doing
    // nothing leaves a blank canvas that the stage goes on to treat as a painted picture.
    if (flat == null) throw new Error('no drawable context');
    const { picture, region, rotation } = ask;
    // To the canvas rather than at the frame's own size: the canvas is capped at what a browser
    // will allocate (`canvasSizeFor`), and a frame past that would otherwise be drawn corner-first
    // and cropped to the part that fitted.
    const bitmap =
      region != null && rotation !== 0 && typeof VideoFrame === 'function' && picture instanceof VideoFrame
        ? await createImageBitmap(picture, { imageOrientation: 'from-image' })
        : null;
    try {
      const drawn = bitmap ?? picture;
      if (region == null) flat.drawImage(drawn, 0, 0, canvas.width, canvas.height);
      else flat.drawImage(drawn, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap?.close();
    }
    return 'drawn';
  }

  /**
   * Draws a decoded frame, or a region of one, into a canvas in extended range.
   *
   * `region` is in the frame's displayed pixels and defaults to all of it. A canvas holding a
   * region is how a reader reaches a photograph's own pixels: the frame decoded to fit the stage
   * has nothing more to show past that, and blowing it up is an upscale of what is already
   * there.
   *
   * Declined where this cannot be done - no device, no WebCodecs frame, or a canvas that already
   * holds a context of another kind - and the caller draws it the ordinary way instead. A
   * canvas holds one kind of context for its whole life, so which of the two a frame uses is
   * settled by the first draw into it and never changes under it.
   *
   * `proof` draws an HDR frame as an sRGB rendition would hold it, its highlights fitted under
   * diffuse white by that operator. A frame that is not HDR is already that, and ignores it.
   */
  private async paintExtended(canvas: OffscreenCanvas, ask: Paint): Promise<Painted> {
    const { device } = this;
    const { picture, region, rotation, proof } = ask;
    if (this.declined || device == null) return 'declined';
    if (!(typeof VideoFrame === 'function' && picture instanceof VideoFrame)) return 'declined';
    const layout = planarLayout(picture, rotation);
    const planar = layout != null;
    const whole = { x: 0, y: 0, width: picture.displayWidth, height: picture.displayHeight };
    const displayed = region ?? whole;
    const stored = planar ? storedRegion(displayed, rotation, picture.codedWidth, picture.codedHeight) : displayed;
    const storedWhole = { x: 0, y: 0, width: picture.codedWidth, height: picture.codedHeight };
    const drawnRegion = planar ? onChromaGrid(stored, layout.chroma, storedWhole) : displayed;

    // **Everything that can decline has to decline before the context is asked for.** A canvas
    // holds one kind of context for its whole life, so taking a WebGPU one and only then failing
    // leaves an element nothing can ever draw into - the 2D path then gets no context either
    // and reports the frame missing, so a photograph that is on disk and fine reads as one the
    // server never built.
    //
    // What is too large is not the same question for the two paths. An import is the whole frame
    // however little of it is drawn, so a sixty-megapixel camera JPEG at 9504 wide is past an
    // 8192 limit before it starts; the planar path uploads only the region, so what matters
    // there is the region. Neither failure throws - an oversized texture comes back invalid and
    // the draw is silently dropped - so both are checked rather than caught.
    const limit = device.limits.maxTextureDimension2D;
    const tooLarge =
      planar ?
        Math.max(drawnRegion.width, drawnRegion.height) > limit
      : Math.max(picture.codedWidth, picture.codedHeight) > limit;
    if (tooLarge) return 'declined';

    // The planes are copied out before the context is taken for the same reason: `copyTo` is
    // real work on a frame the run may close underneath it, and it rejects.
    let planes: GPUTexture[] = [];
    try {
      if (planar) planes = await planesOf(device, picture, drawnRegion, layout.chroma);
    } catch {
      return 'declined';
    }

    // And the import for the same reason again, this being the last call that can fail on the
    // *frame* rather than on the browser: `importExternalTexture` throws on a `VideoFrame` the
    // run closed underneath the draw, which a reader on the arrow key produces routinely. Taken
    // after the context, that throw would spend the canvas and read as a browser that cannot do
    // this at all. It expires at the end of the task that made it, and nothing below awaits.
    let imported: GPUExternalTexture | null = null;
    if (!planar) {
      try {
        // In the canvas's own space, not the default `srgb`: the shader is a passthrough, so
        // whatever the import converts to is what the surface is handed - and sRGB values
        // written into a display-p3 canvas are read as display-p3, which is a picture too
        // saturated by exactly the difference between the two gamuts.
        imported = device.importExternalTexture({ source: picture, colorSpace: 'display-p3' });
      } catch {
        return 'declined';
      }
    }

    const context = canvas.getContext('webgpu');
    if (context == null) {
      for (const plane of planes) plane.destroy();
      return 'declined';
    }
    try {
      if (planar) {
        // Region pixels per canvas pixel, which is one unless the canvas was capped below the
        // region it covers.
        const uniform = colourWords(
          ask.headroom,
          [
            (rotation === 90 || rotation === 270 ? drawnRegion.height : drawnRegion.width) / Math.max(canvas.width, 1),
            (rotation === 90 || rotation === 270 ? drawnRegion.width : drawnRegion.height) / Math.max(canvas.height, 1),
          ],
          layout,
          [0, 0],
          1,
          rotation,
          proof == null ? 0 : PROOF_INTENT[proof],
          ask.sourcePeak,
        );
        device.queue.writeBuffer(pipelinesFor(device).colour, 0, uniform.buffer as ArrayBuffer);
      } else {
        const { x, y, width, height } = drawnRegion;
        const span = new Float32Array([
          x / picture.displayWidth,
          y / picture.displayHeight,
          width / picture.displayWidth,
          height / picture.displayHeight,
        ]);
        device.queue.writeBuffer(pipelinesFor(device).region, 0, span.buffer as ArrayBuffer);
      }
      configure(context, device);

      const drawn = pipelinesFor(device);
      const entries: GPUBindGroupEntry[] =
        imported == null ?
          [
            { binding: 0, resource: planes[0]!.createView() },
            { binding: 1, resource: planes[1]!.createView() },
            { binding: 2, resource: planes[2]!.createView() },
            { binding: 3, resource: { buffer: drawn.colour } },
          ]
        : [
            { binding: 0, resource: drawn.sampler },
            { binding: 1, resource: imported },
            { binding: 2, resource: { buffer: drawn.region } },
          ];

      const pipeline = planar ? drawn.planar : drawn.imported;
      const commands = device.createCommandEncoder();
      const pass = commands.beginRenderPass({
        colorAttachments: [
          { view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } },
        ],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
      pass.draw(3);
      pass.end();
      device.queue.submit([commands.finish()]);
      return 'drawn';
    } catch {
      this.declined = true;
      return 'lost';
    } finally {
      for (const plane of planes) plane.destroy();
    }
  }

  /**
   * Draws a base layer, then a set of masked layers over it, onto one canvas - the merge page's
   * hover preview.
   *
   * Every picture has to be planar PQ, because every one of them is this pipeline's own analysis
   * plane rather than a camera JPEG: there is no imported-texture arm here, and a picture
   * `planarLayout` cannot read has nothing sensible to composite from.
   *
   * Declined under the same conditions `paintExtended` declines for.
   */
  private async paintMasked(canvas: OffscreenCanvas, ask: PaintMasked): Promise<Painted> {
    const { device } = this;
    const { base, layers } = ask;
    if (this.declined || device == null) return 'declined';
    if (planarLayout(base) == null) return 'declined';
    const limit = device.limits.maxTextureDimension2D;
    if (Math.max(base.displayWidth, base.displayHeight) > limit) return 'declined';

    const drawn = pipelinesFor(device);
    const spent: GPUTexture[] = [];
    const written: GPUBuffer[] = [];

    /**
     * What one layer's draw needs, uploaded. A uniform buffer of its own rather than the shared one,
     * because every pass is submitted together below and `writeBuffer` is a queue operation: one
     * buffer written three times would have all three passes read the last value.
     */
    const prepare = async (
      picture: VideoFrame,
      source: ImageBitmap | null,
      shift: readonly [number, number],
      gain: number,
    ): Promise<Prepared | null> => {
      const layout = planarLayout(picture);
      if (layout == null) return null;
      const region = { x: 0, y: 0, width: picture.displayWidth, height: picture.displayHeight };
      const planes = await planesOf(device, picture, region, layout.chroma);
      spent.push(...planes);
      const uniform = device.createBuffer({
        size: COLOUR_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      written.push(uniform);
      const sample = [
        region.width / Math.max(canvas.width, 1),
        region.height / Math.max(canvas.height, 1),
      ] as const;
      device.queue.writeBuffer(uniform, 0, colourWords(ask.headroom, sample, layout, shift, gain).buffer as ArrayBuffer);
      if (source == null) return { planes, uniform, mask: null };
      const mask = device.createTexture({
        size: [canvas.width, canvas.height],
        format: 'r8unorm',
        // RENDER_ATTACHMENT because `copyExternalImageToTexture` demands it of its destination -
        // implementations do that copy as a render pass. Nothing renders into this one, and without
        // the flag the copy is a validation error rather than an exception: the mask stays at zero,
        // every masked layer then contributes nothing, and the canvas shows the base frame whatever
        // the reader picks.
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      spent.push(mask);
      device.queue.copyExternalImageToTexture({ source }, { texture: mask }, [canvas.width, canvas.height]);
      return { planes, uniform, mask };
    };

    try {
      // Every layer's planes are copied out before the canvas is touched, and then the whole
      // composite is one render pass and one submit. It cannot be spread over several: `copyTo`
      // resolves a task or more later, a canvas texture is presented at the end of the frame it was
      // drawn in, and the one after that comes back cleared - so a base pass and the layer passes
      // split across that boundary would load a texture the compositor had already taken, leaving
      // the picture around the tile black.
      const passes: Prepared[] = [];
      try {
        for (const { picture, mask, shift, gain } of [{ picture: base, mask: null, shift: [0, 0] as const, gain: 1 }, ...layers]) {
          const pass = await prepare(picture, mask, shift, gain);
          if (pass != null) passes.push(pass);
        }
      } catch {
        // A frame closed under the copy, as leaving the page does: this paint, not the device.
        return 'declined';
      }

      // After the copies, for the reason `paintExtended` spells out: a canvas holds one kind of
      // context for its whole life, so anything that can still decline has to decline first.
      const context = canvas.getContext('webgpu');
      if (context == null) return 'declined';
      configure(context, device);

      const commands = device.createCommandEncoder();
      const pass = commands.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
          },
        ],
      });
      for (const { planes, uniform, mask } of passes) {
        // One value, both uses: the pipeline and the layout its bind group is built against have to
        // be the same object, and `planar` has one binding fewer than `planarMasked`.
        const pipeline = mask == null ? drawn.planar : drawn.planarMasked;
        const entries: GPUBindGroupEntry[] = [
          { binding: 0, resource: planes[0]!.createView() },
          { binding: 1, resource: planes[1]!.createView() },
          { binding: 2, resource: planes[2]!.createView() },
          { binding: 3, resource: { buffer: uniform } },
          ...(mask == null ? [] : [{ binding: 4, resource: mask.createView() }]),
        ];
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }));
        pass.draw(3);
      }
      pass.end();
      device.queue.submit([commands.finish()]);
      return 'drawn';
    } catch {
      this.declined = true;
      return 'lost';
    } finally {
      for (const texture of spent) texture.destroy();
      for (const buffer of written) buffer.destroy();
    }
  }
}

/**
 * Every draw, not once: a canvas resized for a new frame drops what it was configured with, and
 * reconfiguring an unchanged one costs nothing. `toneMapping` is the setting this path exists
 * for, and is not in the published types yet.
 */
function configure(context: GPUCanvasContext, device: GPUDevice): void {
  context.configure({
    device,
    format: 'rgba16float',
    alphaMode: 'premultiplied',
    colorSpace: 'display-p3',
    toneMapping: { mode: 'extended' },
  } as GPUCanvasConfiguration);
}

/** `Colour` in `stage.slang`, packed as the emitted WGSL declares it: twelve floats. */
const COLOUR_BYTES = 48;

export function colourWords(
  headroom: number,
  sample: readonly [number, number],
  layout: { depth: number; chroma: number },
  shift: readonly [number, number] = [0, 0],
  gain = 1,
  rotation: 0 | 90 | 180 | 270 = 0,
  proof = 0,
  sourcePeak = 1,
): Float32Array {
  const words = new Float32Array(COLOUR_BYTES / 4);
  words.set([headroom, SDR_WHITE_NITS, sample[0], sample[1], layout.depth, layout.chroma, shift[0], shift[1], gain, rotation, proof, sourcePeak]);
  return words;
}

/** One layer of a composite with everything it draws from already on the device. */
interface Prepared {
  planes: GPUTexture[];
  uniform: GPUBuffer;
  /** Null for the base layer, which is opaque everywhere the picture covers. */
  mask: GPUTexture | null;
}
