import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Library } from '../../../schemas/libraries';
import { type ImportLibrary, ImportService } from '../import_service';

const WAIT_MS = 4000;

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'bb-import-links-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function serviceFor(
  library: ImportLibrary,
  others: Pick<Library, 'root_path'>[] = [],
): ImportService {
  return new ImportService(
    { getById: () => library, list: () => [...others, library] },
    { getById: () => null },
    { filesHeld: () => [] },
    { scanLibrary: async () => {} },
    { read: () => Promise.reject(new Error('unused')), liftEmbedded: async () => null },
    () => 1,
    () => {},
  );
}

test('a photo read-only on the card copies, and the copy can be written', async () => {
  const card = path.join(scratch, 'card');
  const root = path.join(scratch, 'library');
  mkdirSync(card);
  mkdirSync(root);
  const protectedPhoto = path.join(card, 'DSC1.ARW');
  writeFileSync(protectedPhoto, 'raw');
  chmodSync(protectedPhoto, 0o444);
  const service = serviceFor({
    id: 'lib00001',
    name: 'Library',
    root_path: root,
    read_only: false,
  });
  const scan = await service.scan(card);

  await service.start({
    scan_id: scan.id,
    library_id: 'lib00001',
    shoot_id: null,
    file_ids: [0],
    delete_originals: false,
  });
  const deadline = performance.now() + WAIT_MS;
  while (service.currentJob()?.status === 'copying') {
    if (performance.now() > deadline) throw new Error('timed out waiting on the import');
    await Bun.sleep(1);
  }

  expect(service.currentJob()).toMatchObject({ copied: 1, failed: 0 });
  expect(statSync(path.join(root, 'DSC1.ARW')).mode & 0o200).toBe(0o200);
});

// Windows needs a privilege to make a symlink.
test.skipIf(process.platform === 'win32').each([
  ['the source folder', 'source'],
  ['the library root', 'root'],
])('refuses to delete a library file when %s is a symlink', async (_, linked) => {
  const realRoot = path.join(scratch, 'catalogued');
  const shoot = path.join(realRoot, 'Trip');
  mkdirSync(shoot, { recursive: true });
  const photo = path.join(shoot, 'DSC1.ARW');
  writeFileSync(photo, 'raw');
  const link = path.join(scratch, 'link');
  symlinkSync(linked === 'source' ? shoot : realRoot, link);
  const destination = path.join(scratch, 'destination');
  mkdirSync(destination);

  const root_path = linked === 'root' ? link : realRoot;
  const catalogued = { root_path };
  const target = { id: 'lib00002', name: 'Destination', root_path: destination, read_only: false };
  const service = serviceFor(target, [catalogued]);
  const scan = await service.scan(linked === 'source' ? link : shoot);
  expect(scan.files).toHaveLength(1);

  await expect(
    service.start({
      scan_id: scan.id,
      library_id: target.id,
      shoot_id: null,
      file_ids: [0],
      delete_originals: true,
    }),
  ).rejects.toThrow('in a library');
  expect(existsSync(photo)).toBe(true);
});
