import { AppError, type ErrorCode } from '../../errors';
import {
  PrintReplySchema,
  type PrintRequest,
  type PrintUnconfirmed,
  type Transport,
} from '../../schemas/printing';
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

const FAILURE_CODES: Record<'invalid' | 'missing' | 'unavailable', ErrorCode> = {
  invalid: 'VALIDATION_ERROR',
  missing: 'NOT_FOUND',
  unavailable: 'UNAVAILABLE',
};

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
            throw timedOut(command, timeoutMs);
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

function timedOut(command: PrintCommand, timeoutMs: number): AppError {
  if (command.kind !== 'submit')
    return new AppError('UNAVAILABLE', `the printer did not answer in ${timeoutMs} ms`);
  return new AppError(
    'UNAVAILABLE',
    `the printer did not confirm the print in ${timeoutMs} ms, so it may still arrive`,
    [{ printUnconfirmed: true } satisfies PrintUnconfirmed],
  );
}

function outcomeOf(data: PrintshimReply): unknown {
  if ('failed' in data) throw new Error(data.failed);
  let reply: unknown;
  try {
    reply = JSON.parse(data.reply);
  } catch {
    throw unreadable();
  }
  const parsed = PrintReplySchema.safeParse(reply);
  if (!parsed.success) throw unreadable();
  if (!parsed.data.ok)
    throw new AppError(
      FAILURE_CODES[parsed.data.kind ?? 'unavailable'],
      parsed.data.error ?? 'the printer refused',
    );
  return reply;
}

export function unreadable(): AppError {
  return new AppError('UNAVAILABLE', "the printer's reply couldn't be read");
}
