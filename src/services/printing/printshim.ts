import { AppError } from '../../errors';
import { PrintReplySchema, type PrintRequest, type Transport } from '../../schemas/printing';
import { workerEntry } from '../worker_entry';

export type PrintJob = PrintRequest['job'] & { transport: Transport };

export type PrintCommand =
  | { kind: 'list' }
  | { kind: 'capabilities'; printer: string }
  | { kind: 'profile'; printer: string; name: string }
  | { kind: 'submit'; printer: string; image: string; job: PrintJob }
  | { kind: 'job'; printer: string; jobId: number };

export type PrintshimReply = { reply: string } | { failed: string };

export type PrintshimRun = (command: PrintCommand, timeoutMs: number) => Promise<unknown>;

/** A worker per command: a spooler that never answers holds that thread, never the next command's. */
export function printshimWorkers(
  entry: string | URL = workerEntry(
    'printshim_worker',
    new URL('./printshim_worker.ts', import.meta.url),
  ),
): PrintshimRun {
  return (command, timeoutMs) =>
    new Promise((resolve, reject) => {
      const worker = new Worker(entry);
      const settle = (answer: () => void): void => {
        clearTimeout(timer);
        worker.terminate();
        try {
          answer();
        } catch (err) {
          reject(err);
        }
      };
      const timer = setTimeout(
        () =>
          settle(() => {
            throw new AppError('UNAVAILABLE', `the printer did not answer in ${timeoutMs} ms`);
          }),
        timeoutMs,
      );
      worker.onmessage = ({ data }: MessageEvent<PrintshimReply>) =>
        settle(() => resolve(outcomeOf(data)));
      worker.onerror = (event: ErrorEvent) =>
        settle(() => {
          throw new Error(`the print worker crashed: ${event.message}`);
        });
      worker.postMessage(command);
    });
}

function outcomeOf(data: PrintshimReply): unknown {
  if ('failed' in data) throw new Error(data.failed);
  const parsed = PrintReplySchema.parse(JSON.parse(data.reply));
  if (!parsed.ok) throw new AppError('UNAVAILABLE', parsed.error ?? 'the printer refused');
  return parsed.outcome;
}
