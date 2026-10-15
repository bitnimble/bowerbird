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

  /** `null` closes each connection without answering. */
  async answer(reply: string | null): Promise<void> {
    const server = createServer((connection) => {
      let request = '';
      connection.setEncoding('utf8');
      connection.on('data', (chunk: string) => {
        request += chunk;
        if (!request.endsWith('\n')) return;
        this.asked.push(JSON.parse(request));
        connection.end(reply == null ? '' : `${reply}\n`);
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(this.socket, resolve));
  }

  close(): void {
    this.server?.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
}
