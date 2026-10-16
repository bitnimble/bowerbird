import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger } from '../../logger';
import { ShellResources } from '../shell_resources';

let dir: string | null = null;

afterEach(async () => {
  if (dir != null) await rm(dir, { recursive: true, force: true });
});

test('keeps its samples for the next run, which logs the ones before it', async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bb-shell-resources-'));
  const file = path.join(dir, 'shell-resources.log');
  await writeFile(file, 'before the crash');
  const info = spyOn(Logger.prototype, 'info');
  const resources = new ShellResources(file, process.pid);
  await resources.start();
  const logged = info.mock.calls.map((call) => call[1]);
  info.mockRestore();
  expect(logged).toContainEqual({ shell: 'before the crash' });
  expect(await readFile(file, 'utf8')).toMatch(
    /^\S+Z rss .+; \d+ threads \(\d+ .+\); \d+ maps \(\d+ .+\)$/,
  );
});
