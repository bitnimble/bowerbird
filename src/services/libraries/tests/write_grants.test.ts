import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ShellWriteGrants } from '../write_grants';

let server: Server | null = null;
let dir: string | null = null;

afterEach(() => {
  server?.close();
  server = null;
  if (dir != null) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function shell(reply: string): Promise<{ socket: string; asked: unknown[] }> {
  dir = mkdtempSync(path.join(tmpdir(), 'write-grants-'));
  const socket = path.join(dir, 'shell.sock');
  const asked: unknown[] = [];
  server = createServer((connection) => {
    let request = '';
    connection.setEncoding('utf8');
    connection.on('data', (chunk: string) => {
      request += chunk;
      if (!request.endsWith('\n')) return;
      asked.push(JSON.parse(request));
      connection.end(`${reply}\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(socket, resolve));
  return { socket, asked };
}

describe('ShellWriteGrants', () => {
  it('asks the shell for every path and resolves once it allows them', async () => {
    const { socket, asked } = await shell('{"granted":true,"reason":null}');
    await new ShellWriteGrants(socket).grant(['/storage/emulated/0/DCIM/Camera/PXL_1.jpg', '/b']);
    expect(asked).toEqual([{ grant_writes: ['/storage/emulated/0/DCIM/Camera/PXL_1.jpg', '/b'] }]);
  });

  it('refuses as read-only with the reason the shell gave', async () => {
    const { socket } = await shell('{"granted":false,"reason":"You declined the change."}');
    const refused = new ShellWriteGrants(socket).grant(['/a']);
    await expect(refused).rejects.toMatchObject({
      code: 'READ_ONLY',
      message: 'You declined the change.',
    });
  });

  it('asks in chunks a single platform request can carry', async () => {
    const { socket, asked } = await shell('{"granted":true,"reason":null}');
    const paths = Array.from({ length: 1200 }, (_, i) => `/p${i}.jpg`);
    await new ShellWriteGrants(socket).grant(paths);
    expect(asked).toEqual([
      { grant_writes: paths.slice(0, 500) },
      { grant_writes: paths.slice(500, 1000) },
      { grant_writes: paths.slice(1000) },
    ]);
  });

  it('reports an answer it cannot read as an IO error', async () => {
    const { socket } = await shell('not json');
    const refused = new ShellWriteGrants(socket).grant(['/a']);
    await expect(refused).rejects.toMatchObject({ code: 'IO_ERROR' });
  });

  it('asks nothing for no paths', async () => {
    const { socket, asked } = await shell('{"granted":false,"reason":null}');
    await new ShellWriteGrants(socket).grant([]);
    expect(asked).toEqual([]);
  });

  it('reports a shell that is not listening as an IO error', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'write-grants-'));
    const refused = new ShellWriteGrants(path.join(dir, 'missing.sock')).grant(['/a']);
    await expect(refused).rejects.toMatchObject({ code: 'IO_ERROR' });
  });
});
