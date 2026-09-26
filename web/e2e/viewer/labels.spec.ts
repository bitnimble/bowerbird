// Labels, where only a browser can answer: a pill added in the viewer surviving a reload, and a
// label dragged to a new place in the edit dialog. What each control is wired to is
// `labels_presenter.test.ts`, and the dialog's delete and save `edit_labels_dialog.test.tsx`.
import { expect, type Page } from '@playwright/test';
import { test } from '../fixtures';
import { LabelListSchema } from '../../../src/schemas/labels';
import { PathSegment, route } from '../../../src/schemas/route';
import { LABEL_PHOTOS_DIR } from '../fixture_library';
import { gotoLibrary, gotoPhoto, libraryOf, showMetadata, useLibrary } from '../helpers';

// The second test counts the labels the first made, so they run in order on one catalogue.
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  await useLibrary(browser, LABEL_PHOTOS_DIR);
});

const labelsRow = (page: Page) => page.getByRole('list', { name: 'Labels' });

async function labelNames(page: Page): Promise<string[]> {
  const library = await libraryOf(page, LABEL_PHOTOS_DIR);
  const listed = await page.request.get(route(PathSegment.api(), PathSegment.labels()));
  return LabelListSchema.parse(await listed.json())
    .filter((label) => label.library_id === library.id)
    .map((label) => label.name);
}

test('a label made in the viewer stays on the photo across a reload, and comes off', async ({ page }) => {
  await gotoPhoto(page, LABEL_PHOTOS_DIR);
  await showMetadata(page);
  await expect(page.getByRole('group', { name: 'Info', exact: true })).toBeVisible();

  await labelsRow(page).getByRole('button', { name: 'Add label' }).click();
  await page.getByRole('textbox', { name: 'Find or create a label' }).fill('Keeper');
  await page.keyboard.press('Enter');
  await expect(labelsRow(page).getByRole('listitem').filter({ hasText: 'Keeper' })).toBeVisible();

  await page.reload();
  await showMetadata(page);
  const pill = labelsRow(page).getByRole('listitem').filter({ hasText: 'Keeper' });
  await expect(pill).toBeVisible();

  await pill.getByRole('button', { name: 'Remove Keeper' }).click();
  await expect(pill).toHaveCount(0);
});

test('the edit dialog reorders labels by dragging them', async ({ page }) => {
  const library = await libraryOf(page, LABEL_PHOTOS_DIR);
  for (const name of ['Sky', 'Sea']) {
    const made = await page.request.post(route(PathSegment.api(), PathSegment.labels()), {
      data: { library_id: library.id, name, colour: '#0090ff' },
    });
    expect(made.ok()).toBe(true);
  }
  expect(await labelNames(page)).toEqual(['Keeper', 'Sky', 'Sea']);

  await gotoLibrary(page, LABEL_PHOTOS_DIR);
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('button', { name: 'Labels' }).click();
  await page.getByRole('button', { name: 'Edit labels…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit labels' });
  await expect(dialog.getByRole('textbox', { name: 'Label name' })).toHaveCount(3);

  const from = await dialog.getByRole('button', { name: 'Move Sea' }).boundingBox();
  const to = await dialog.getByRole('button', { name: 'Move Keeper' }).boundingBox();
  if (from == null || to == null) throw new Error('the drag handles are not on screen');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 4, { steps: 12 });
  await page.mouse.up();
  await expect(dialog.getByRole('textbox', { name: 'Label name' }).first()).toHaveValue('Sea');

  // dnd-kit swallows every click for 50ms after a drop, and Playwright clicks faster than a hand.
  await page.waitForTimeout(100);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await labelNames(page)).toEqual(['Sea', 'Keeper', 'Sky']);
});
