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
test('the add-library dialog warns that a bin name the root already uses will be adopted', async ({
  page,
}) => {
  mkdirSync(path.join(ROOT_WITH_BIN, 'Bin'), { recursive: true });

  await page.goto(route(PathSegment.settings()));
  await page.getByRole('button', { name: 'Add library' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add library' });
  const chooser = page.getByRole('dialog', { name: 'Choose folder' });
  const root = chooser.getByLabel('Library root');
  await expect(root).not.toHaveValue('');
  await expect(dialog).toHaveCount(0);
  await root.fill(ROOT_WITH_BIN);
  await root.press('Enter');
  await expect(chooser.getByRole('button', { name: 'Bin', exact: true })).toBeVisible();
  await chooser.getByRole('button', { name: 'Choose folder' }).click();
  await expect(chooser).toHaveCount(0);

  await expect(dialog.getByRole('textbox', { name: 'Library root' })).toHaveCount(0);
  const binName = dialog.getByLabel('Bin folder name');
  const confirm = dialog.getByRole('button', { name: 'Add library' });
  const warning = dialog.getByText('already has a folder called "Bin"');
  await expect(warning).toBeVisible();
  // A warning, not a refusal: the reader can go ahead with it.
  await expect(confirm).toBeEnabled();

  await binName.fill('Deleted');
  await expect(warning).toHaveCount(0);
  await expect(confirm).toBeEnabled();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('a path closed with a slash walks the picker into it without an Enter', async ({ page }) => {
  mkdirSync(path.join(ROOT_WITH_BIN, 'Bin'), { recursive: true });

  await page.goto(route(PathSegment.settings()));
  await page.getByRole('button', { name: 'Add library' }).click();

  const dialog = page.getByRole('dialog', { name: 'Add library' });
  const chooser = page.getByRole('dialog', { name: 'Choose folder' });
  const root = chooser.getByLabel('Library root');
  await expect(root).not.toHaveValue('');
  await root.fill(`${ROOT_WITH_BIN}/`);

  await expect(chooser.getByRole('button', { name: 'Bin', exact: true })).toHaveCount(1);
  await chooser.getByRole('button', { name: 'Choose folder' }).click();
  await expect(
    dialog.getByText(`${ROOT_WITH_BIN} already has a folder called "Bin"`),
  ).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
});

test('the chosen folder can be changed from the add-library dialog', async ({ page }) => {
  mkdirSync(path.join(ROOT_WITH_BIN, 'Bin'), { recursive: true });

  await page.goto(route(PathSegment.settings()));
  await page.getByRole('button', { name: 'Add library' }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose folder' });
  const root = chooser.getByLabel('Library root');
  await expect(root).not.toHaveValue('');
  await chooser.getByRole('button', { name: 'Choose folder' }).click();
  await expect(chooser).toHaveCount(0);

  const dialog = page.getByRole('dialog', { name: 'Add library' });
  await expect(dialog.locator(':focus')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Choose folder' }).click();
  await expect(root).not.toHaveValue('');
  await root.fill(`${ROOT_WITH_BIN}/`);
  await expect(chooser.getByRole('button', { name: 'Bin', exact: true })).toHaveCount(1);
  await chooser.getByRole('button', { name: 'Choose folder' }).click();

  await expect(chooser).toHaveCount(0);
  await expect(dialog.getByText(ROOT_WITH_BIN, { exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
