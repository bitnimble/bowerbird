import init, {
  type Decoded,
  type InitOutput,
  decodeRaw,
  openGpuDevice,
  prepareRaw,
} from '../../../../native/rawshim/pkg/rawshim';
import type { JobGrade } from '../../../../src/services/processing/rawshim_job';

export type LocalFrame = {
  width: number;
  height: number;
  halved: boolean;
  samples: Uint16Array;
};

/** `crate::edit::EditRequest`, which the module takes as JSON. */
export type LocalOpen = {
  /** Longest edge the decode is fitted to, which is the size every tick then grades. */
  longEdge: number;
  /**
   * This photograph's camera match, where one has been kept.
   *
   * Half a second of the open, and it depends on nothing but the file - so an open that has been
   * through this before skips the fit entirely.
   *
   * Bytes as numbers because this whole struct crosses as JSON: a `Uint8Array` here stringifies to
   * an object of numeric keys, which the far side rejects as a malformed request.
   */
  cameraMatch?: number[];
  grade: JobGrade;
  /** No denoise: it runs in the tick, so a frame prepared here carries its noise deliberately. */
  strengths: { sharpen: number; defringe: number };
};

/**
 * The decoder module, and the device it opened.
 *
 * wgpu cannot adopt a `GPUDevice` from JS - there is no `from_webgpu`, and wgpu-hal has no WebGPU
 * backend to inject one through - so the module requests the device and the page borrows *its*
 * one. Two devices cannot share a texture, so whichever side owns it, the other takes it from
 * there.
 */
export class LocalDecoder {
  private module: Promise<InitOutput> | null = null;
  private device: Promise<GPUDevice | null> | null = null;

  async ready(): Promise<InitOutput> {
    this.module ??= init();
    return this.module;
  }

  /** The module's device, or null where the browser has no WebGPU and the decode runs on the CPU. */
  async gpu(): Promise<GPUDevice | null> {
    await this.ready();
    this.device ??= openGpuDevice().catch(() => null);
    return this.device;
  }

  async open(raw: Uint8Array, atLeastLongEdge: number): Promise<LocalFrame> {
    const wasm = await this.ready();
    let decoded: Decoded | undefined;
    try {
      decoded = await decodeRaw(raw, atLeastLongEdge);
      const view = new Uint16Array(wasm.memory.buffer, decoded.ptr, decoded.length);
      return {
        width: decoded.width,
        height: decoded.height,
        halved: decoded.halved,
        // Copied, not handed out: the view is over the module's memory, and the next allocation
        // that grows it detaches every view taken before the growth.
        samples: new Uint16Array(view),
      };
    } finally {
      decoded?.free();
    }
  }

  /**
   * The editor's open, framed exactly as `/image/:id/prepared` frames it.
   *
   * Handed back rather than parsed here, so one reader takes it apart whichever host prepared it.
   */
  async prepare(raw: Uint8Array, request: LocalOpen): Promise<Uint8Array> {
    await this.ready();
    return prepareRaw(raw, JSON.stringify(request));
  }
}
