import type { Job } from '../../../schemas/jobs';
import { workerEntry } from '../../worker_entry';
import type { RawshimCommand, RawshimCommandReply } from './rawshim_command_worker';

export class RawshimCommandWorker {
  private readonly worker = new Worker(
    workerEntry('rawshim_command_worker', new URL('./rawshim_command_worker.ts', import.meta.url)),
  );
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  async render(job: Job): Promise<void> {
    const reply = await this.request({ kind: 'render', job });
    if (reply.kind !== 'rendered') throw new Error('worker returned groups for a render');
  }

  async group(
    command: Omit<Extract<RawshimCommand, { kind: 'group' }>, 'kind'>,
  ): Promise<Int32Array> {
    const reply = await this.request({ kind: 'group', ...command });
    if (reply.kind !== 'grouped') throw new Error('worker returned a render for groups');
    return reply.groups;
  }

  close(): void {
    this.closed = true;
    this.worker.terminate();
  }

  private request(
    command: RawshimCommand,
  ): Promise<Exclude<RawshimCommandReply, { kind: 'failed' }>> {
    const reply = this.queue.then(
      () =>
        new Promise<Exclude<RawshimCommandReply, { kind: 'failed' }>>((resolve, reject) => {
          if (this.closed) {
            reject(new Error('worker is closed'));
            return;
          }
          this.worker.onmessage = (event: MessageEvent<RawshimCommandReply>) => {
            if (event.data.kind === 'failed') reject(new Error(event.data.error));
            else resolve(event.data);
          };
          this.worker.onerror = (event: ErrorEvent) => {
            this.close();
            reject(new Error(`worker crashed: ${event.message}`));
          };
          this.worker.postMessage(command);
        }),
    );
    this.queue = reply.catch(() => undefined);
    return reply;
  }
}

export async function renderNativeJob(job: Job): Promise<void> {
  const worker = new RawshimCommandWorker();
  try {
    await worker.render(job);
  } finally {
    worker.close();
  }
}
