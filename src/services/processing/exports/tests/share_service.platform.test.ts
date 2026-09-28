import { afterEach, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dataPathForLibraryId } from '../../../../utils/paths';
import { ShareService } from '../share_service';
import { LibraryActivity } from '../../../activity/library_activity';

const LIB = 'lib-share-service';

const photoRenditions = {
    locate: () => ({
      library: { id: LIB, rendition_hdr: false },
      photo: { id: 'p1', file_path: null, recipe: { kind: 'file', path: 'a.arw' } },
    }),
  } as unknown as ConstructorParameters<typeof ShareService>[0];

const shares = new ShareService(
  photoRenditions,
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

it('keeps share preparation visible until the JPEG arrives and clears failures', async () => {
  const activity = new LibraryActivity();
  const jpeg = Promise.withResolvers<Uint8Array | null>();
  const sharing = new ShareService(
    { ...photoRenditions, embeddedJpeg: () => jpeg.promise },
    { shareable: () => Promise.resolve(new Uint8Array()) },
    activity,
  );
  const run = sharing.jpeg('p1', 'embedded');
  expect(activity.current(LIB)).toEqual([{ kind: 'sharing', count: 1 }]);
  jpeg.resolve(new Uint8Array([1, 2, 3]));
  expect(await run).toEqual(new Uint8Array([1, 2, 3]));
  expect(activity.current(LIB)).toEqual([]);
  await expect(sharing.jpeg('p1', 'full')).rejects.toThrow('image not found on disk');
  expect(activity.current(LIB)).toEqual([]);
});
