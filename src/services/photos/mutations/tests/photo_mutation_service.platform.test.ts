import { describe, it, expect, jest } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Library } from '../../../../schemas/libraries';
import { fileRecipe } from '../../../../schemas/recipes';
import { build } from './photo_mutation_service_test_helpers';

describe('PhotoMutationService.delete', () => {
  // One bin at the library root, laid out inside itself like the folders it took
  // the photographs from (§12.3), so what is in it can be read without the
  // catalogue and two files of the same name from different folders cannot meet.
  it('mirrors the folder a photo was binned from inside the one root Bin', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-mirror-'));
    try {
      mkdirSync(path.join(root, 'A', 'B', 'C'), { recursive: true });
      mkdirSync(path.join(root, 'D'), { recursive: true });
      writeFileSync(path.join(root, 'A', 'B', 'C', 'foo.arw'), 'deep');
      writeFileSync(path.join(root, 'D', 'foo.arw'), 'shallow');
      writeFileSync(path.join(root, 'foo.arw'), 'root');

      const lib: Library = {
        id: 'lib',
        root_path: root,
        bin_name: 'Bin',
        read_only: false,
        name: 'lib',
        ordering: 'added_asc',
        rendition_source: 'embedded' as const,
        rendition_hdr: false,
        render_skip_full: [],
        render_skip_max: [],
        denoiser: 'galosh',
        include_subfolders: true,
        include_non_raw: false,
        auto_stack: true,
        auto_stack_similarity: 0.78,
        auto_stack_window_seconds: 60,
        last_synced_at: null,
        photo_count: 0,
        missing_photo_count: 0,
        unavailable_photo_count: 0,
        rendered_photo_count: 0,
      };
      const markDeleted = jest.fn();
      const setFilePath = jest.fn();
      const rows = [
        { id: 'p1', library_id: 'lib', shoot_id: 'sh', recipe: fileRecipe('A/B/C/foo.arw') },
        { id: 'p2', library_id: 'lib', shoot_id: null, recipe: fileRecipe('D/foo.arw') },
        { id: 'p3', library_id: 'lib', shoot_id: null, recipe: fileRecipe('foo.arw') },
      ];
      const { service } = build({
        photoPaths: { getBasicByIds: jest.fn(() => rows), markDeleted, setFilePath },
        libraries: { getById: jest.fn(() => lib) },
      });

      await service.delete(['p1', 'p2', 'p3']);

      // No bin inside the shoot folder, and the three same-named files sit apart.
      expect(existsSync(path.join(root, 'A', 'B', 'C', 'Bin'))).toBe(false);
      expect(readFileSync(path.join(root, 'Bin', 'A', 'B', 'C', 'foo.arw'), 'utf8')).toBe('deep');
      expect(readFileSync(path.join(root, 'Bin', 'D', 'foo.arw'), 'utf8')).toBe('shallow');
      expect(readFileSync(path.join(root, 'Bin', 'foo.arw'), 'utf8')).toBe('root');
      expect(setFilePath).toHaveBeenCalledWith('p1', 'Bin/A/B/C/foo.arw');
      // Where restore puts it back, which is the folder it came from and not the bin.
      expect(markDeleted).toHaveBeenCalledWith('p1', 'A/B/C/foo.arw', undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
