import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileRecipe } from '../../../../schemas/recipes';
import { localOriginals } from '../../../blobs/originals_for_testing';
import type { PhotoRenditionService } from '../../../photos/renditions/photo_rendition_service';
import type { ProcessingService } from '../../pipeline/processing_service';
import { PrintRenderer, type PrintRenderTarget } from '../print_renderer';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bb-print-'));
  await writeFile(path.join(root, 'photo.arw'), 'raw');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function renderer(renderPrint: ProcessingService['renderPrint']): PrintRenderer {
  return new PrintRenderer(
    {
      locate: () => ({
        photo: { id: 'photo', recipe: fileRecipe('photo.arw') },
        library: { id: 'prints', root_path: root },
      }),
    } as unknown as PhotoRenditionService,
    { renderPrint } as unknown as ProcessingService,
    localOriginals(),
  );
}

const target: PrintRenderTarget = {
  space: 'adobe-rgb',
  bits: 16,
  intent: 'relative',
  blackPointCompensation: false,
  icc: null,
  width: 1800,
  height: 1200,
  quarterTurns: 3,
};

test('renders the located original as the print the target names', async () => {
  const asked: Parameters<ProcessingService['renderPrint']>[] = [];
  await renderer(async (...args) => {
    asked.push(args);
  }).renderPrint('photo', target, '/tmp/out.png');
  const [raw, photoId, library, outputPath, print] = asked[0]!;
  expect(raw).toBe(path.join(root, 'photo.arw'));
  expect(photoId).toBe('photo');
  expect(library.id).toBe('prints');
  expect(outputPath).toBe('/tmp/out.png');
  expect(print).toEqual({
    space: 'adobe-rgb',
    bits: 16,
    intent: 'relativeColorimetric',
    blackPointCompensation: false,
    icc: null,
    width: 1800,
    height: 1200,
    quarterTurns: 3,
  });
});

test('a device print carries the profile, and is refused without one', async () => {
  const asked: Parameters<ProcessingService['renderPrint']>[] = [];
  const prints = renderer(async (...args) => {
    asked.push(args);
  });
  const icc = new Uint8Array([1, 2, 3]);
  await prints.renderPrint('photo', { ...target, space: 'device', icc }, '/tmp/out.png');
  expect(asked[0]![4]).toMatchObject({ space: 'device', icc });
  await expect(
    prints.renderPrint('photo', { ...target, space: 'device' }, '/tmp/out.png'),
  ).rejects.toThrow('printer profile');
  expect(asked).toHaveLength(1);
});
