import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { ShellWriteGrants } from '../write_grants';
import { FakeShell } from './fake_shell';

let shell: FakeShell;

beforeEach(() => {
  shell = new FakeShell();
});

afterEach(() => {
  shell.close();
});

describe('ShellWriteGrants', () => {
  it('asks the shell for every path and resolves once it allows them', async () => {
    await shell.answer('{"granted":true,"reason":null}');
    await new ShellWriteGrants(shell.socket).grant([
      '/storage/emulated/0/DCIM/Camera/PXL_1.jpg',
      '/b',
    ]);
    expect(shell.asked).toEqual([
      { grant_writes: ['/storage/emulated/0/DCIM/Camera/PXL_1.jpg', '/b'] },
    ]);
  });

  it('refuses as read-only with the reason the shell gave', async () => {
    await shell.answer('{"granted":false,"reason":"You declined the change."}');
    const refused = new ShellWriteGrants(shell.socket).grant(['/a']);
    await expect(refused).rejects.toMatchObject({
      code: 'READ_ONLY',
      message: 'You declined the change.',
    });
  });

  it('asks in chunks a single platform request can carry', async () => {
    await shell.answer('{"granted":true,"reason":null}');
    const paths = Array.from({ length: 1200 }, (_, i) => `/p${i}.jpg`);
    await new ShellWriteGrants(shell.socket).grant(paths);
    expect(shell.asked).toEqual([
      { grant_writes: paths.slice(0, 500) },
      { grant_writes: paths.slice(500, 1000) },
      { grant_writes: paths.slice(1000) },
    ]);
  });

  it('reports an answer it cannot read as an IO error', async () => {
    await shell.answer('not json');
    const refused = new ShellWriteGrants(shell.socket).grant(['/a']);
    await expect(refused).rejects.toMatchObject({ code: 'IO_ERROR' });
  });

  it('asks nothing for no paths', async () => {
    await shell.answer('{"granted":false,"reason":null}');
    await new ShellWriteGrants(shell.socket).grant([]);
    expect(shell.asked).toEqual([]);
  });

  it('reports a shell that is not listening as an IO error', async () => {
    const refused = new ShellWriteGrants(shell.socket).grant(['/a']);
    await expect(refused).rejects.toMatchObject({ code: 'IO_ERROR' });
  });
});
