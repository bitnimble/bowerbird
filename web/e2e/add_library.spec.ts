import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { E2E_ROOT } from './fixture_library';

// A root that already keeps a folder called Bin. Adopting it as the deletion bin
// would drop everything inside from every scan, so the dialog has to catch it
// before the library exists (§12.3).
const ROOT_WITH_BIN = path.join(E2E_ROOT, 'has-a-bin');

// Nothing here is submitted, so the run's shared catalogue is left as it was and
// the rail the other specs read stays theirs.
test('the add-library dialog refuses a bin name the root already uses, and takes another', async ({ page }) => {
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
  await expect(binName).toHaveAttribute('aria-invalid', 'true');
  await expect(confirm).toBeDisabled();

  await binName.fill('Deleted');
  await expect(binName).not.toHaveAttribute('aria-invalid', 'true');
  await expect(confirm).toBeEnabled();

  await page.locator('.ui-modal').getByRole('button', { name: 'Cancel' }).click();
});
