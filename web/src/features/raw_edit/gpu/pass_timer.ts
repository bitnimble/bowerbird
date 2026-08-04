// Where a tick's milliseconds actually go.
//
// Differencing two arms of the bench said the peak pass cost 5.7ms and said nothing about
// which part: a dispatch over a million pixels and a dispatch over one workgroup are
// indistinguishable from outside. Twice now that gap has hidden the real cost, so the
// passes report their own.

/** The timings of one submit, by pass label, in milliseconds. */
export type PassMs = Record<string, number>;

export class PassTimer {
  static supported(device: GPUDevice): boolean {
    return device.features.has('timestamp-query');
  }

  private readonly set: GPUQuerySet;
  private readonly resolved: GPUBuffer;
  private readonly staging: GPUBuffer;
  private labels: string[] = [];

  constructor(device: GPUDevice, capacity = 16) {
    this.set = device.createQuerySet({ type: 'timestamp', count: capacity * 2 });
    this.resolved = device.createBuffer({
      size: capacity * 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.staging = device.createBuffer({
      size: capacity * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  /** Starts a submit's worth of passes, discarding whatever the last one recorded. */
  begin(): void {
    this.labels = [];
  }

  /** What to hand a pass descriptor so this pass is the next one timed. */
  writes(label: string): GPURenderPassTimestampWrites {
    const index = this.labels.length;
    this.labels.push(label);
    return {
      querySet: this.set,
      beginningOfPassWriteIndex: index * 2,
      endOfPassWriteIndex: index * 2 + 1,
    };
  }

  /** Records the resolve, which has to happen in the encoder the passes were in. */
  resolve(encoder: GPUCommandEncoder): void {
    if (this.labels.length === 0) return;
    encoder.resolveQuerySet(this.set, 0, this.labels.length * 2, this.resolved, 0);
    encoder.copyBufferToBuffer(this.resolved, 0, this.staging, 0, this.labels.length * 16);
  }

  /** Milliseconds per pass, once the submit those passes were in has finished. */
  async read(): Promise<PassMs> {
    const labels = this.labels;
    this.labels = [];
    if (labels.length === 0) return {};
    await this.staging.mapAsync(GPUMapMode.READ);
    const stamps = new BigUint64Array(this.staging.getMappedRange().slice(0));
    this.staging.unmap();

    const out: PassMs = {};
    for (const [i, label] of labels.entries()) {
      const ns = Number(stamps[i * 2 + 1]! - stamps[i * 2]!);
      out[label] = Number((ns / 1e6).toFixed(2));
    }
    return out;
  }

  destroy(): void {
    this.set.destroy();
    this.resolved.destroy();
    this.staging.destroy();
  }
}
