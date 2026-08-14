import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { E2E_ROOT } from './fixture_library';

// A root that already keeps a folder called Bin. It is adopted as the deletion
// bin rather than refused, so what is inside imports as already-binned - which
// is a different library from the one the reader may have meant, and the dialog
// says so while the name can still be changed (§12.3).
const ROOT_WITH_BIN = path.join(E2E_ROOT, 'has-a-bin');

// Nothing here is submitted, so the run's shared catalogue is left as it was and
// the rail the other specs read stays theirs.
test('the add-library dialog warns that a bin name the root already uses will be adopted', async ({ page }) => {
  mkdirSync(path.join(ROOT_WITH_BIN, 'Bin'), { recursive: true });

  await page.goto('/settings');
  await page.getByRole('button', { name: 'Add library' }).click();

  // Enter walks the picker to the typed path, which is what puts the listing on
  // the folder the box names - the dialog answers from that listing.
  const root = page.getByLabel('Library root path');
  await expect(root).not.toHaveValue('');
  await root.fill(ROOT_WITH_BIN);
  await root.press('Enter');

  const binName = page.getByLabel('Bin folder name');
  const confirm = page.locator('.ui-modal').getByRole('button', { name: 'Add library' });
  const warning = page.locator('.ui-modal .field__warning');
  await expect(warning).toContainText('already has a folder called "Bin"');
  // A warning, not a refusal: the reader can go ahead with it.
  await expect(confirm).toBeEnabled();

  await binName.fill('Deleted');
  await expect(warning).toHaveCount(0);
  await expect(confirm).toBeEnabled();

  await page.locator('.ui-modal').getByRole('button', { name: 'Cancel' }).click();
});
