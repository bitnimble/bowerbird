import { adapterName } from '../../../adapter_name';
import type { GpuThread } from '../../../gpu/gpu_thread';

export type AdapterInfo = { name: string; maxTexture: number };

export type OnPage = { canvas: HTMLCanvasElement; width: number; height: number };

/** What an edit visit keeps across the photos it opens, until {@link close}. */
export class EditSurface {
  readonly stageKey: number;
  /** `transferControlToOffscreen` is once per element, for good. */
  private readonly handed = new WeakSet<HTMLCanvasElement>();
  readonly onPage: Partial<Record<'stage' | 'loupe', OnPage>> = {};
  private adapter: AdapterInfo | null = null;

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

  /** Whether `canvas` was already given to the worker, marking it given either way. */
  alreadyHandedOver(canvas: HTMLCanvasElement): boolean {
    if (this.handed.has(canvas)) return true;
    this.handed.add(canvas);
    return false;
  }

  close(): void {
    this.thread.dropSurface(this.stageKey);
  }
}
