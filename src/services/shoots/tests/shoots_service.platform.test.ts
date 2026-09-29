import { describe, it, expect, jest } from 'bun:test';
import {
  makeService,
  mockLibs,
  mockPhotos,
  mockRules,
  mockShoots,
  shoot,
  withRoot,
} from './shoots_service_test_helpers';

describe('ShootsService.create', () => {
  it(
    'refuses a parent_path that climbs out of the library',
    withRoot(async (root) => {
      const service = makeService(mockShoots(), mockPhotos(), mockLibs(root), mockRules());
      await expect(
        service.create({
          library_id: 'lib',
          parent_path: '../elsewhere',
          name: 'Trip',
          ordering: 'taken_desc',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }),
  );

  it(
    'records the folder identity, so a rename before the first scan is still followed',
    withRoot(async (root) => {
      const insert = jest.fn();
      const service = makeService(
        mockShoots({ insert, getById: jest.fn(() => shoot) }),
        mockPhotos(),
        mockLibs(root),
        mockRules(),
      );

      await service.create({
        library_id: 'lib',
        parent_path: '',
        name: 'Trip',
        ordering: 'taken_desc',
      });

      const [written] = insert.mock.calls[0] as [{ folder_ino: number | null }];
      expect(written.folder_ino).toBeGreaterThan(0);
    }),
  );
});
