import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PathSegment, route } from '../../../src/schemas/route';
import { E2E_ROOT } from '../fixture_library';

// A root that already keeps a folder called Bin. It is adopted as the deletion
// bin rather than refused, so what is inside imports as already-binned - which
// is a different library from the one the reader may have meant, and the dialog
// says so while the name can still be changed (§12.3).
const ROOT_WITH_BIN = path.join(E2E_ROOT, 'has-a-bin ');

// Nothing here is submitted, so the run's shared catalogue is left as it was and
// the sidebar the other specs read stays theirs.
test('the add-library dialog warns that a bin name the root already uses will be adopted', async ({ page }) => {
  mkdirSync(path.join(ROOT_WITH_BIN, 'Bin'), { recursive: true });

  await page.goto(route(PathSegment.settings()));
  await page.getByRole('button', { name: 'Add library' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add library' });
  await expect(dialog.getByRole('textbox', { name: 'Library root' })).toHaveCount(0);
  const height = (await dialog.boundingBox())!.height;
  await dialog.getByRole('button', { name: 'Choose folder' }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose folder' });
  const root = chooser.getByLabel('Library root');
  await expect(root).not.toHaveValue('');
  await root.fill(ROOT_WITH_BIN);
  await root.press('Enter');
  await expect(chooser.getByRole('button', { name: 'Bin', exact: true })).toBeVisible();
  await chooser.getByRole('button', { name: 'Choose folder' }).click();
  await expect(chooser).toHaveCount(0);

  const binName = dialog.getByLabel('Bin folder name');
  const confirm = dialog.getByRole('button', { name: 'Add library' });
  const warning = dialog.getByText('already has a folder called "Bin"');
  await expect(warning).toBeVisible();
  // A warning, not a refusal: the reader can go ahead with it.
  await expect(confirm).toBeEnabled();
  // Walking the picker is what makes the warning appear, and a dialog that grew
  // to hold it would take Add out from under the pointer that is over it.
  expect((await dialog.boundingBox())!.height).toBe(height);

  await binName.fill('Deleted');
  await expect(warning).toHaveCount(0);
  await expect(confirm).toBeEnabled();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

// Asked in the dialog rather than left to Settings, because the import begins as the row lands
// (§9.8) - so a library added with it left alone has already walked past every JPEG beside its
// RAWs by the time anyone could switch it on. Off by default, which is the whole point of asking:
// one frame arriving as two rows is what the default is protecting against.
test('the add-library dialog offers the finished formats, switched off', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await page.getByRole('button', { name: 'Add library' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add library' });
  const nonRaw = dialog.getByRole('checkbox', { name: 'Import JPEG, PNG, HEIC, and AVIF too' });
  await expect(nonRaw).not.toBeChecked();
  await nonRaw.check();
  await expect(nonRaw).toBeChecked();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('a path closed with a slash walks the picker into it without an Enter', async ({ page }) => {
  mkdirSync(path.join(ROOT_WITH_BIN, 'Bin'), { recursive: true });

  await page.goto(route(PathSegment.settings()));
  await page.getByRole('button', { name: 'Add library' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add library' });
  await dialog.getByRole('button', { name: 'Choose folder' }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose folder' });
  const root = chooser.getByLabel('Library root');
  await expect(root).not.toHaveValue('');
  await root.fill(`${ROOT_WITH_BIN}/`);

  await expect(chooser.getByRole('button', { name: 'Bin', exact: true })).toHaveCount(1);
  await chooser.getByRole('button', { name: 'Choose folder' }).click();
  await expect(dialog.getByText(`${ROOT_WITH_BIN} already has a folder called "Bin"`)).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
});
