import { describe, it, expect, jest } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDataPath } from '../../../utils/paths';
import { build, mockRepo } from './libraries_service_test_helpers';

describe('LibrariesService.create', () => {
  // Nothing inside is lost by adopting it: the bin channel walks the folder on
  // the first sync and imports what it holds as already-binned (§12.3).
  it('adopts a folder the root already holds at the bin name, identity and all', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bb-'));
    const insert = jest.fn();
    try {
      mkdirSync(path.join(root, 'Bin'));
      const existing = statSync(path.join(root, 'Bin'));
      const service = build(mockRepo({ insert }));
      const library = await service.create({ root_path: root, bin_name: 'Bin', read_only: false, ordering: 'added_asc', include_subfolders: true, include_non_raw: false, rendition_source: 'render', auto_stack: true });

      expect(library.bin_name).toBe('Bin');
      // The folder that was there, not a second one made beside it: the identity
      // written at the insert is what a later rename is followed by (§9.1.1).
      expect(insert).toHaveBeenCalledWith({ ...library, identity: expect.objectContaining({ ino: existing.ino }) });
      rmSync(getDataPath(library), { recursive: true, force: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
