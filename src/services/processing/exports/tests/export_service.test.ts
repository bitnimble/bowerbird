import { afterEach, beforeEach, expect, jest, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Logger } from '../../../../logger';
import { ExportOptionsSchema } from '../../../../schemas/export';
import { fileRecipe } from '../../../../schemas/recipes';
import { localOriginals } from '../../../blobs/originals_for_testing';
import type { PhotoRenditionService } from '../../../photos/renditions/photo_rendition_service';
import type { SettingsRepository } from '../../../settings/settings_repository';
import type { ProcessingService } from '../../pipeline/processing_service';
import { ExportService } from '../export_service';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'bb-export-log-'));
  await writeFile(path.join(root, 'photo.arw'), 'raw');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function service(renderExport: ProcessingService['renderExport']): ExportService {
  return new ExportService(
    { locate: () => ({
      photo: { id: 'photo', recipe: fileRecipe('photo.arw') },
      library: { id: 'export-log', root_path: root },
    }) } as unknown as PhotoRenditionService,
    { renderExport } as unknown as ProcessingService,
    localOriginals(),
    { get: () => ({ avif_speed: 8 }) } as unknown as SettingsRepository,
  );
}

test('logs export inputs and completion around the render and encode boundaries', async () => {
  const logged = jest.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
  try {
    const exporter = service(async (_raw, _id, _library, output) => {
      expect(logged.mock.calls.some(([message]) => message === 'export rendering')).toBe(true);
      await writeFile(output, new Uint8Array([1, 2, 3]));
    });
    const file = await exporter.exportOne('photo', ExportOptionsSchema.parse({ format: 'avif', longEdge: 800 }));
    expect(file.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(logged.mock.calls.map(([message]) => message)).toEqual([
      'export started', 'export opening originals', 'export rendering', 'export encoding', 'export finished',
    ]);
    expect(logged.mock.calls[0]?.[1]).toMatchObject({ photo: 'photo', format: 'avif', longEdge: 800, hdr: true });
    expect(logged.mock.calls.at(-1)?.[1]).toMatchObject({ photo: 'photo', bytes: 3 });
  } finally { logged.mockRestore(); }
});

test('reports both gain-map render arms and failure without a finished export', async () => {
  const logged = jest.spyOn(Logger.prototype, 'info').mockImplementation(() => {});
  const failed = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  try {
    const exporter = service(async (_raw, _id, _library, output, options) => {
      if (!options.exportHdr) throw new Error('SDR render failed');
      await writeFile(output, 'hdr');
    });
    await expect(exporter.exportOne('photo', ExportOptionsSchema.parse({ format: 'avif', gainMap: true })))
      .rejects.toThrow('SDR render failed');
    expect(logged.mock.calls.filter(([message]) => message === 'export rendering').map(([, fields]) => fields?.hdr)).toEqual([true, false]);
    expect(logged.mock.calls.some(([message]) => message === 'export finished')).toBe(false);
    expect(failed.mock.calls.at(-1)?.[0]).toBe('export failed');
  } finally { logged.mockRestore(); failed.mockRestore(); }
});
