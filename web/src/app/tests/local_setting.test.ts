import { expect, test } from 'bun:test';
import type { Invoke } from '../../api/transport';
import { PortedFiles, serveFiles, ShellStorage, type DeviceFiles } from '../local_setting';

function shellHolding(files: Map<string, string>): { invoke: Invoke; writes: string[] } {
  const writes: string[] = [];
  const invoke: Invoke = async (command, args) => {
    const { name, contents } = args as { name: string; contents?: string };
    if (command === 'read_device_file') return files.get(name) ?? null;
    if (command === 'write_device_file' && contents != null) {
      writes.push(name);
      files.set(name, contents);
      return null;
    }
    throw new Error(`unexpected ${command}`);
  };
  return { invoke, writes };
}

test('the shell keeps preferences across a relaunch, which a new origin would lose', async () => {
  const files = new Map<string, string>();
  const { invoke } = shellHolding(files);
  const first = await ShellStorage.open(invoke);
  expect(first.read('sidebar-width')).toBeNull();
  first.write('sidebar-width', '300');
  first.write('pipelines-precompiled', '0.1.15');
  await first.flush();

  const relaunched = await ShellStorage.open(invoke);
  expect(relaunched.read('sidebar-width')).toBe('300');
  expect(relaunched.read('pipelines-precompiled')).toBe('0.1.15');
});

test('a drag writing on every move saves a handful of times, ending on its last value', async () => {
  const files = new Map<string, string>();
  const { invoke, writes } = shellHolding(files);
  const storage = await ShellStorage.open(invoke);
  for (let width = 200; width < 300; width++) storage.write('sidebar-width', String(width));
  await storage.flush();
  expect(writes.length).toBeLessThanOrEqual(2);
  expect(JSON.parse(files.get('preferences')!)).toEqual({ 'sidebar-width': '299' });
});

test('a preferences file that will not parse reads as none', async () => {
  const { invoke } = shellHolding(new Map([['preferences', '{not json']]));
  expect((await ShellStorage.open(invoke)).read('anything')).toBeNull();
});

test('a preferences file that could not be read is never written over', async () => {
  const writes: string[] = [];
  const failing: Invoke = async (command) => {
    if (command === 'read_device_file') throw new Error('permission denied');
    writes.push(command);
    return null;
  };
  const storage = await ShellStorage.open(failing);
  storage.write('sidebar-width', '300');
  await storage.flush();
  expect(storage.read('sidebar-width')).toBe('300');
  expect(writes).toEqual([]);
});

test('saves land in the order they were asked for', async () => {
  const files = new Map<string, string>();
  const order: string[] = [];
  const slowFirst: Invoke = async (command, args) => {
    const { name, contents } = args as { name: string; contents?: string };
    if (command === 'read_device_file') return files.get(name) ?? null;
    if (contents === 'older') await new Promise((resolve) => setTimeout(resolve, 20));
    order.push(contents ?? '');
    files.set(name, contents ?? '');
    return null;
  };
  const storage = await ShellStorage.open(slowFirst);
  await Promise.all([storage.save('recipes', 'older'), storage.save('recipes', 'newer')]);
  expect(order).toEqual(['older', 'newer']);
  expect(await storage.load('recipes')).toBe('newer');
});

test('a worker reads and writes files through the page that serves them', async () => {
  const held = new Map<string, string>();
  const channel = new MessageChannel();
  const served: DeviceFiles = {
    load: async (name) => held.get(name) ?? null,
    save: async (name, contents) => void held.set(name, contents),
  };
  serveFiles(channel.port1, () => served);
  // Asked before the port has arrived, as the worker's warm-up does.
  const port = Promise.withResolvers<MessagePort>();
  const files = new PortedFiles(port.promise);
  const early = files.load('pipeline-recipes');
  port.resolve(channel.port2);

  expect(await early).toBeNull();
  await files.save('pipeline-recipes', '{"recipes":[]}');
  expect(await files.load('pipeline-recipes')).toBe('{"recipes":[]}');
  channel.port1.close();
  channel.port2.close();
});
