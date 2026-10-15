import { createConnection } from 'node:net';
import { z } from 'zod';
import { AppError } from '../../errors';

/** Leave from the platform to move or delete originals another app owns, asked for before the change. */
export interface WriteGrants {
  grant(paths: readonly string[]): Promise<void>;
}

/** A desktop, where the filesystem's own permissions are the whole answer. */
export const UNRESTRICTED_WRITES: WriteGrants = { grant: async () => {} };

// One createWriteRequest each, whose URIs cross a single 1 MB binder transaction.
const GRANT_CHUNK = 500;
const ANSWER_TIMEOUT_MS = 330_000;

function parsedOrNull(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const GrantReplySchema = z.object({
  granted: z.boolean(),
  reason: z.string().nullable(),
});

export class ShellWriteGrants implements WriteGrants {
  constructor(private readonly socketPath: string) {}

  async grant(paths: readonly string[]): Promise<void> {
    for (let from = 0; from < paths.length; from += GRANT_CHUNK) {
      const chunk = paths.slice(from, from + GRANT_CHUNK);
      const line = await this.ask({ grant_writes: chunk });
      const reply = GrantReplySchema.safeParse(parsedOrNull(line));
      if (!reply.success) throw new AppError('IO_ERROR', `the app answered a grant with ${line}`);
      if (!reply.data.granted) {
        throw new AppError(
          'READ_ONLY',
          reply.data.reason ?? `this device did not allow changes to ${chunk.length} photo(s)`,
        );
      }
    }
  }

  private ask(request: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
      const failed = (why: string): void =>
        reject(
          new AppError('IO_ERROR', `could not ask the app for leave to change photos: ${why}`),
        );
      let reply = '';
      const socket = createConnection(this.socketPath);
      socket.setEncoding('utf8');
      // Past `photos.rs`'s wait on the prompt, so a slow reader gets the shell's answer.
      socket.setTimeout(ANSWER_TIMEOUT_MS, () => {
        socket.destroy();
        failed('it did not answer');
      });
      socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', (chunk: string) => {
        reply += chunk;
        const end = reply.indexOf('\n');
        if (end < 0) return;
        socket.end();
        resolve(reply.slice(0, end));
      });
      socket.on('end', () => failed('it closed the connection without answering'));
      socket.on('error', (err) => failed(err.message));
    });
  }
}
