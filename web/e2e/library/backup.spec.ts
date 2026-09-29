import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { BackupRunResponseSchema } from '../../../src/schemas/backup';
import { PathSegment, route } from '../../../src/schemas/route';
import { test } from '../fixtures';
import { BACKUP_PHOTOS_DIR, E2E_ROOT } from '../fixture_library';
import { gotoLibrary, libraryOf, useLibrary } from '../helpers';

test.describe.configure({ mode: 'serial' });
test.beforeAll(async ({ browser }) => { await useLibrary(browser, BACKUP_PHOTOS_DIR); });

test('backup status loads on the library, updates after a run, survives reload and focuses recovery', async ({ page }) => {
  const library = await libraryOf(page, BACKUP_PHOTOS_DIR);
  const folder = path.join(E2E_ROOT, 'backup-target');
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const selected = await page.request.put(route(PathSegment.api(), PathSegment.backup()), {
    data: { library_id: library.id, path: folder, name: 'Library backup' },
  });
  expect(selected.ok(), await selected.text()).toBe(true);
  await gotoLibrary(page, BACKUP_PHOTOS_DIR);
  const line = page.getByRole('status', { name: 'Backup', exact: true });
  await expect(line.getByText('Waiting to back up 2 originals', { exact: true })).toBeVisible();
  const conflict = path.join(folder, 'alpha.arw');
  writeFileSync(conflict, 'a different file');
  const response = await page.request.post(route(PathSegment.api(), PathSegment.backup(), library.id, PathSegment.run()));
  expect(response.ok(), await response.text()).toBe(true);
  const { report } = BackupRunResponseSchema.parse(await response.json());
  expect(report.outcome).toBe('partial');
  await expect(line.getByText('A backup location contains a different file.', { exact: true })).toBeVisible();
  await page.reload();
  await expect(line.getByText('A backup location contains a different file.', { exact: true })).toBeVisible();
  await line.getByRole('link', { name: 'View backup' }).click();
  const dialog = page.getByRole('dialog', { name: /^Settings for / });
  await expect(dialog.getByRole('region', { name: 'Backup', exact: true })).toBeFocused();
  const panel = dialog.getByRole('group', { name: 'Backup', exact: true });
  await panel.getByText(/^Current backup issues \(/).click();
  const issues = panel.getByRole('group').filter({ has: page.getByText(/^Current backup issues \(/) });
  await expect(issues.getByText('alpha.arw', { exact: true })).toBeVisible();
  await expect(issues.getByText('Compare both files before choosing which to keep, move, or replace, then retry.', { exact: true })).toBeVisible();
  rmSync(conflict);
  await panel.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(panel.getByText('No originals are waiting to back up.', { exact: true })).toBeVisible();
  await expect(panel.getByText(/^Current backup issues \(/)).toHaveCount(0);
  await expect(panel.getByText('2 of 2 originals were last recorded on this backup.', { exact: true })).toBeVisible();
});
