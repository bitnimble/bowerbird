import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect } from '@playwright/test';
import { test } from '../fixtures';
import { E2E_ROOT } from '../fixture_library';
import {
  addLibrary,
  bands,
  frames,
  fusedBands,
  gotoLibrary,
  rowTiles,
  setViewMode,
  stackFrames,
} from '../helpers';

// A band's members are laid out from CSS the two engines read differently - an
// aspect ratio against a stretched grid row, and a capped flex line - so this one
// runs in Firefox as well as Chromium (`playwright.config.ts`). Its own library,
// since the projects share a catalogue and each needs to be the one that stacked it.
const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), '../../../test/fixtures/DSC02981.ARW');
const NAMES = ['DSC09001.ARW', 'DSC09002.ARW'];

// Both members are portrait, which is the shape that stretched a masonry band.
async function openBand(page: import('@playwright/test').Page, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const name of NAMES) copyFileSync(FIXTURE, path.join(dir, name));
  await addLibrary(page, dir, { autoStack: true, photos: NAMES.length });
  await gotoLibrary(page, dir);
  await expect(stackFrames(page)).toBeVisible({ timeout: 60_000 });
  await frames(rowTiles(page)).click();
  await expect(bands(page).getByRole('listitem')).toHaveCount(NAMES.length);
}

const box = async (locator: import('@playwright/test').Locator) => (await locator.boundingBox())!;

// A band's outline is the same distance from a member on every side, which is the
// cell edge: its members are the collection's tiles at the collection's places, and
// they hold their own inset (`TILE_PAD`), so its ring lands on no photograph. What
// this asserts is that none of them hangs *outside* it, in any view.
async function expectInsetFromBand(page: import('@playwright/test').Page, where: string): Promise<void> {
  const band = await box(bands(page));
  const members = await bands(page).getByRole('listitem').all();
  for (const locator of members) {
    const member = await box(locator);
    expect(member.height, `${where}: a member with no height`).toBeGreaterThan(0);
    expect(member.y, `${where}: top edge`).toBeGreaterThanOrEqual(band.y - 0.5);
    expect(member.y + member.height, `${where}: bottom edge`).toBeLessThanOrEqual(band.y + band.height + 0.5);
    expect(member.x, `${where}: left edge`).toBeGreaterThanOrEqual(band.x - 0.5);
    expect(member.x + member.width, `${where}: right edge`).toBeLessThanOrEqual(band.x + band.width + 0.5);
  }
}

test('a band insets its members, at the shape of the view around them', async ({ page }, info) => {
  await openBand(page, path.join(E2E_ROOT, `band-layout-${info.project.name}`));
  const tile = rowTiles(page).first();
  const member = bands(page).getByRole('listitem').first();

  // Grid: the collection's own cell, at the collection's own column - the band is
  // taller than the rows it covers, and that is the only thing its inset costs.
  // Firefox laid these out at no height at all while the height was left to
  // `align-self: stretch` against an aspect ratio.
  await setViewMode(page, 'Grid');
  const gridTile = await box(tile);
  const gridMember = await box(member);
  expect(gridMember.height).toBeCloseTo(gridTile.height, 0);
  expect(gridMember.width).toBeCloseTo(gridTile.width, 0);
  expect(gridMember.x).toBeCloseTo(gridTile.x, 0);
  await expectInsetFromBand(page, 'grid');

  // Masonry: nothing bounds a band's line there, so it is capped against the stack's
  // own tile - and what it no longer takes is left empty to the right of it.
  await setViewMode(page, 'Masonry');
  await expect.poll(() => fusedBands(page)).toBe(1);
  const masonryTile = await box(tile);
  const masonryMember = await box(member);
  const band = await box(bands(page));
  expect(masonryMember.height).toBeLessThanOrEqual(masonryTile.height * 1.3 + 1);
  expect(masonryMember.width * NAMES.length).toBeLessThan(band.width - 100);
  await expectInsetFromBand(page, 'masonry');

  // The band's notch is cut where the tile it joins actually is, and only the tile
  // can say: masonry packs it. So what the tile measured has to be the tile's whole
  // box, pad and all, which is what the notch, the bridge across the row gap and
  // the fillet at each end are placed from. Measuring its content box instead is
  // wrong by the pad at one edge only - a shade of the band's colour left painting
  // under the tile's ring - and every part of that is invisible to a bounds check.
  // The bridge is placed in the band's own box, which in masonry spans its block.
  const notch = await bands(page).evaluate((el) => ({
    x: parseFloat(getComputedStyle(el, '::before').left),
    width: parseFloat(getComputedStyle(el, '::before').width),
  }));
  expect(notch.width).toBeCloseTo(masonryTile.width, 0);
  expect(notch.x).toBeCloseTo(masonryTile.x - band.x, 0);

  // A masonry cell is the shape of the photograph in it, so the picture fills the
  // frame: taking the aspect on the cell instead left it a shade wider than the
  // picture, and the backdrop showed down two edges of every tile.
  for (const locator of [tile, member]) {
    const picture = await locator.locator('img').evaluate((el: HTMLImageElement) => ({
      frame: el.clientWidth / el.clientHeight,
      own: el.naturalWidth / el.naturalHeight,
    }));
    expect(picture.frame).toBeCloseTo(picture.own, 2);
  }

  // List: the collection's own row height. Indented rather than flush, which is the
  // one place a band's members are not where the collection's rows are: a list row
  // is read from its left edge (§19.6).
  await setViewMode(page, 'List');
  const listTile = await box(tile);
  const listMember = await box(member);
  expect(listMember.height).toBeCloseTo(listTile.height, 0);
  expect(listMember.x).toBeGreaterThan(listTile.x);
  await expectInsetFromBand(page, 'list');
});
