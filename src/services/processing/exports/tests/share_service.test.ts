import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataPathForLibraryId } from '../../../../utils/paths';
import { localOriginals } from '../../../blobs/originals_for_testing';
import { ShareService } from '../share_service';

const LIB = 'lib-share-service';

const shares = new ShareService(
  {
    locate: () => ({
      library: { id: LIB, rendition_hdr: false },
      photo: { id: 'p1', file_path: null, recipe: { kind: 'file', path: 'a.arw' } },
    }),
  } as unknown as ConstructorParameters<typeof ShareService>[0],
  localOriginals(),
  { editOrientation: () => 0 },
  { shareable: () => Promise.resolve(new Uint8Array()) },
);

function stored(variant: string): void {
  const directory = path.join(dataPathForLibraryId(LIB), 'renditions', variant);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'p1.avif'), 'render');
}

afterEach(() => rmSync(dataPathForLibraryId(LIB), { recursive: true, force: true }));

it('prefers the viewer-sized rendition where both are built', async () => {
  stored('full');
  stored('max');
  expect(await shares.built('p1')).toBe('full');
});

it('takes the native-size rendition where it is the only one built', async () => {
  stored('max');
  expect(await shares.built('p1')).toBe('max');
});

it("falls back to the camera's JPEG where nothing is built", async () => {
  expect(await shares.built('p1')).toBe('embedded');
});
