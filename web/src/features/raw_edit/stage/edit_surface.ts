import { adapterName } from '../../../adapter_name';
import type { GpuThread } from '../../../gpu/gpu_thread';
import { vp9Encoder } from '../../../vp9/vp9_encoder';

type AdapterInfo = { name: string; maxTexture: number };

/** A canvas the page shows itself, as a canvas of its own or, with `video`, as a video over it. */
type OnPage = { canvas: HTMLCanvasElement; width: number; height: number; video: boolean };

/** What an edit visit keeps across the photos it opens, until {@link close}. */
export class EditSurface {
  readonly stageKey: number;
  /** `transferControlToOffscreen` is once per element, for good. */
  private readonly handed = new WeakSet<HTMLCanvasElement>();
  readonly onPage: Partial<Record<'stage' | 'loupe', OnPage>> = {};
  private adapter: AdapterInfo | null = null;
  private stageHanded = false;

  constructor(private readonly thread: Pick<GpuThread, 'keepSurface' | 'dropSurface'>) {
    this.stageKey = thread.keepSurface();
  }

  async adapterInfo(): Promise<AdapterInfo | null> {
    if (this.adapter != null) return this.adapter;
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter == null) return null;
    this.adapter = { name: adapterName(adapter), maxTexture: adapter.limits.maxTextureDimension2D };
    return this.adapter;
  }

  handedOver(canvas: HTMLCanvasElement): boolean {
    return this.handed.has(canvas);
  }

  get stageHandedOver(): boolean {
    return this.stageHanded;
  }

  handOver(canvas: HTMLCanvasElement, which: 'stage' | 'loupe'): void {
    this.handed.add(canvas);
    if (which === 'stage') this.stageHanded = true;
  }

  close(): void {
    this.thread.dropSurface(this.stageKey);
    vp9Encoder.close();
  }
}
