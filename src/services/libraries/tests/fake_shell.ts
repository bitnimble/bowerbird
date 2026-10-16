import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A Unix socket standing in for the Android shell: it records each request and answers one line. */
export class FakeShell {
  readonly asked: unknown[] = [];
  private readonly dir = mkdtempSync(path.join(tmpdir(), 'fake-shell-'));
  /** Nothing listens here until `answer`. */
  readonly socket = path.join(this.dir, 'shell.sock');
  private server: Server | null = null;
  private readonly held: (() => void)[] = [];

  /** `null` closes each connection without answering; `held` waits for `release`. */
  async answer(reply: string | null, { held = false } = {}): Promise<void> {
    const server = createServer((connection) => {
      let request = '';
      connection.setEncoding('utf8');
      connection.on('data', (chunk: string) => {
        request += chunk;
        if (!request.endsWith('\n')) return;
        this.asked.push(JSON.parse(request));
        const send = (): void => void connection.end(reply == null ? '' : `${reply}\n`);
        if (held) this.held.push(send);
        else send();
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.socket, resolve));
  }

  /** Answers the oldest held request. */
  release(): void {
    this.held.shift()?.();
  }

  close(): void {
    this.server?.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
