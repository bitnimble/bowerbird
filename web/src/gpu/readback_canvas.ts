// Canvases the page draws itself, from frames the GPU thread drew and read back (`readback.slang`).
//
// **WebKit caps a transferred canvas at the headroom of its default HDR image content**: 1000 nits
// over 203, whatever the display reaches, measured on an XDR panel with the peak raised in its own
// settings. A canvas the page configures on its own device is not capped. So on WebKit, and only
// where this device's peak is past that cap, a canvas stays on the page and the worker hands back
// what it drew instead of drawing into it.
import READBACK_WGSL from '../features/photos/generated/readback.wgsl?raw';
import { displayPeakNits } from '../app/device';
import { SDR_WHITE_NITS } from '../features/photos/viewer/stage_gpu';

/** What WebKit lets a transferred canvas show above SDR white: 1000 nits over 203. */
const TRANSFERRED_HEADROOM = 1000 / 203;

/** A frame the GPU thread drew, as RGB9E5 words, a row of `width` after another. */
export interface ReadFrame {
  words: Uint32Array;
  width: number;
  height: number;
}

/** Whether a canvas should stay on the page rather than be transferred to the GPU thread. */
export function drawsOnThePage(devicePeakNits: number): boolean {
  const peak = displayPeakNits(devicePeakNits);
  return isWebKit() && peak != null && peak / SDR_WHITE_NITS > TRANSFERRED_HEADROOM;
}

function isWebKit(): boolean {
  const agent = globalThis.navigator?.userAgent ?? '';
  return /AppleWebKit/.test(agent) && !/Chrome|Chromium|Edg\//.test(agent);
}

interface Drawing {
  device: GPUDevice;
  blit: GPURenderPipeline;
}

/** The page's own WebGPU device, and the one pipeline it draws with. */
class ReadbackCanvases {
  private drawing: Promise<Drawing | null> | null = null;

  /** `frame` onto `canvas`, at the frame's own size. */
  async show(canvas: HTMLCanvasElement, frame: ReadFrame): Promise<void> {
    const drawing = await this.opened();
    if (drawing == null)
      throw new Error('this page has no WebGPU device to draw a read-back frame with');
    const { device } = drawing;
    const texture = device.createTexture({
      size: [frame.width, frame.height],
      format: 'rgb9e5ufloat',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    try {
      device.queue.writeTexture(
        { texture },
        frame.words.buffer as ArrayBuffer,
        {
          offset: frame.words.byteOffset,
          bytesPerRow: frame.width * 4,
          rowsPerImage: frame.height,
        },
        [frame.width, frame.height],
      );
      this.blit(canvas, drawing, texture);
    } finally {
      texture.destroy();
    }
  }

  /** A bitmap onto `canvas`, for a frame the GPU thread could only draw in 2D. */
  async showBitmap(canvas: HTMLCanvasElement, bitmap: ImageBitmap): Promise<void> {
    const drawing = await this.opened();
    if (drawing == null) throw new Error('this page has no WebGPU device to draw a bitmap with');
    const { device } = drawing;
    const texture = device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: 'rgba16float',
      // RENDER_ATTACHMENT because `copyExternalImageToTexture` demands it of its destination.
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    });
    try {
      device.queue.copyExternalImageToTexture(
        { source: bitmap },
        { texture, colorSpace: 'display-p3' },
        [bitmap.width, bitmap.height],
      );
      this.blit(canvas, drawing, texture);
    } finally {
      texture.destroy();
      bitmap.close();
    }
  }

  private blit(canvas: HTMLCanvasElement, { device, blit }: Drawing, texture: GPUTexture): void {
    if (canvas.width !== texture.width || canvas.height !== texture.height) {
      canvas.width = texture.width;
      canvas.height = texture.height;
    }
    const context = canvas.getContext('webgpu');
    if (context == null) throw new Error('this canvas gave no WebGPU context');
    context.configure({
      device,
      format: 'rgba16float',
      alphaMode: 'premultiplied',
      colorSpace: 'display-p3',
      toneMapping: { mode: 'extended' },
    } as GPUCanvasConfiguration);
    const commands = device.createCommandEncoder();
    const pass = commands.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });
    pass.setPipeline(blit);
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: blit.getBindGroupLayout(0),
        entries: [{ binding: 3, resource: texture.createView() }],
      }),
    );
    pass.draw(3);
    pass.end();
    device.queue.submit([commands.finish()]);
  }

  private opened(): Promise<Drawing | null> {
    this.drawing ??= (async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (adapter == null) return null;
      const device = await adapter.requestDevice();
      // A lost device takes every call without throwing and draws nothing, so the next show opens another.
      void device.lost.then(() => {
        this.drawing = null;
      });
      const module = device.createShaderModule({ code: READBACK_WGSL });
      const blit = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vertex' },
        fragment: { module, entryPoint: 'blit', targets: [{ format: 'rgba16float' }] },
        primitive: { topology: 'triangle-list' },
      });
      return { device, blit };
    })();
    return this.drawing;
  }
}

export const readbackCanvases = new ReadbackCanvases();
