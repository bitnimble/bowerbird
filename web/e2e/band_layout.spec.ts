import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_ROOT } from './fixture_library';
import { addLibrary, openLibrary, syncLibrary, waitForSyncSettled } from './helpers';

// A band's members are laid out from CSS the two engines read differently - an
// aspect ratio against a stretched grid row, and a capped flex line - so this one
// runs in Firefox as well as Chromium (`playwright.config.ts`). Its own library,
// since the projects share a catalogue and each needs to be the one that stacked it.
const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), '../../test/fixtures/DSC02981.ARW');
const NAMES = ['DSC09001.ARW', 'DSC09002.ARW'];

// Both members are portrait, which is the shape that stretched a masonry band.
async function openBand(page: import('@playwright/test').Page, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const name of NAMES) copyFileSync(FIXTURE, path.join(dir, name));
  await addLibrary(page, dir, { autoStack: true });
  await syncLibrary(page, dir);
  await waitForSyncSettled(page, dir, NAMES.length);
  await openLibrary(page, dir);
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 60_000 });
  await page.locator('.tile:not(.tile--member) .tile__hit').click();
  await expect(page.locator('.grid__band .tile')).toHaveCount(NAMES.length);
}

const box = async (locator: import('@playwright/test').Locator) => (await locator.boundingBox())!;

test('a band draws its members at the size the view around them uses', async ({ page }, info) => {
  await openBand(page, path.join(E2E_ROOT, `band-layout-${info.project.name}`));
  const tile = page.locator('.tile:not(.tile--member)').first();
  const member = page.locator('.grid__band .tile').first();

  // Grid: exactly the collection's own cell. Firefox laid these out at no height at
  // all while the height was left to `align-self: stretch` against an aspect ratio.
  const gridTile = await box(tile);
  const gridMember = await box(member);
  expect(gridMember.height).toBeCloseTo(gridTile.height, 0);
  expect(gridMember.width).toBeCloseTo(gridTile.width, 0);

  // Masonry: nothing bounds a band's line there, so it is capped against the stack's
  // own tile - and what it no longer takes is left empty to the right of it.
  await page.getByRole('button', { name: 'Masonry', exact: true }).click();
  await expect(page.locator('.grid__band--fused')).toHaveCount(1);
  const masonryTile = await box(tile);
  const masonryMember = await box(member);
  const band = await box(page.locator('.grid__band'));
  expect(masonryMember.height).toBeGreaterThan(0);
  expect(masonryMember.height).toBeLessThanOrEqual(masonryTile.height * 1.3 + 1);
  expect(masonryMember.width * NAMES.length).toBeLessThan(band.width - 100);

  // List: the collection's own row height.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  const listTile = await box(tile);
  const listMember = await box(member);
  expect(listMember.height).toBeCloseTo(listTile.height, 0);

  await page.getByRole('button', { name: 'Grid', exact: true }).click();
});
