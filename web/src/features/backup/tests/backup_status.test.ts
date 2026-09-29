import { expect, test } from 'bun:test';
import { backupPresentation } from '../backup_status';
import { BackupStatusStrings } from '../backup_status.strings';
import { backupStatus } from './backup_fixture';

test('backup attention names a failure when paused transfers are also present', () => {
  expect(
    backupPresentation(
      backupStatus({
        status: 'attention',
        issues: {
          total: 2,
          counts: [
            { code: 'paused', count: 1 },
            { code: 'no_space', count: 1 },
          ],
          samples: [],
        },
      }),
    ).label,
  ).toBe("There isn't enough space.");
});

test('backup attention names originals missing everywhere before any other issue', () => {
  const status = backupStatus({
    status: 'attention',
    issues: {
      total: 3,
      counts: [
        { code: 'no_space', count: 1 },
        { code: 'local_missing', count: 2 },
      ],
      samples: [],
    },
  });
  expect(
    backupPresentation({ ...status, coverage: { ...status.coverage, missing_originals: 2 } }).label,
  ).toBe("We couldn't find 2 originals on this device or this backup.");
});

test('backup storage and permission advice names the drive involved in the operation', () => {
  expect(BackupStatusStrings.advice('no_space', 'restoring')).toBe(
    'Free storage on this device, then retry restoring the originals.',
  );
  expect(BackupStatusStrings.advice('no_space', 'copying')).toBe(
    'Free storage on the backup drive, then retry.',
  );
  expect(BackupStatusStrings.advice('read_only', 'copying')).toBe(
    'Check that the backup drive and folder allow changes, then retry.',
  );
  expect(BackupStatusStrings.advice('read_only', 'offloading')).toBe(
    'Check the library read-only setting and folder permissions on this device, then retry.',
  );
});
