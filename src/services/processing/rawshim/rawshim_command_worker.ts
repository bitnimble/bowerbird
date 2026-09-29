import type { Job } from '../../../schemas/jobs';
import { runJob } from './rawshim_job';
import { stackGroups } from './rawshim_ops';

export type RawshimCommand =
  | { kind: 'render'; job: Job }
  | {
      kind: 'group';
      descriptors: Uint8Array[];
      timestamps: BigInt64Array;
      threshold: number;
      windowSeconds: number;
    };

export type RawshimCommandReply =
  | { kind: 'rendered' }
  | { kind: 'grouped'; groups: Int32Array }
  | { kind: 'failed'; error: string };

declare const self: {
  onmessage: ((event: MessageEvent<RawshimCommand>) => void) | null;
  postMessage: (message: RawshimCommandReply) => void;
};

self.onmessage = ({ data }) => {
  try {
    if (data.kind === 'render') {
      runJob(data.job);
      self.postMessage({ kind: 'rendered' });
      return;
    }
    self.postMessage({
      kind: 'grouped',
      groups: stackGroups(
        data.descriptors.map((descriptor) => Buffer.from(descriptor)),
        data.timestamps,
        data.threshold,
        data.windowSeconds,
      ),
    });
  } catch (err) {
    self.postMessage({ kind: 'failed', error: err instanceof Error ? err.message : String(err) });
  }
};
