import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E_ROOT } from '../fixture_library';
import {
  addLibrary,
  bands,
  frames,
  gallery,
  openLibrary,
  scanLibrary,
  setHideSidebarInViewer,
  shownFrame,
  stackFrames,
  waitForScanSettled,
} from '../helpers';

// A stack in the viewer's filmstrip, which is the one place its cells are laid out
// against a real box: what the strip's own arithmetic says about a spine is
// `strip_view.test.ts`, and this is that arithmetic meeting the stylesheet.
const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), '../../../test/fixtures/DSC02981.ARW');
const NAMES = ['DSC09101.ARW', 'DSC09102.ARW'];
const ROOT = path.join(E2E_ROOT, 'viewer-filmstrip');

// Portrait enough that the photograph is bound by the width, which is what puts the
// strip along the foot (`stripEdge`). Wider than the mobile breakpoint, so the bar
// is still the one holding the strip's own toggle.
test.use({ viewport: { width: 1000, height: 1200 } });
test.describe.configure({ timeout: 180_000 });

test('an open stack is a spine, and the photograph on the stage is ringed inside its band', async ({ page }) => {
  mkdirSync(ROOT, { recursive: true });
  for (const name of NAMES) copyFileSync(FIXTURE, path.join(ROOT, name));
  await addLibrary(page, ROOT, { autoStack: true });
  await scanLibrary(page, ROOT);
  await waitForScanSettled(page, ROOT, NAMES.length);
  // The sidebar stays, because the edge the strip takes is decided by the shape of the
  // stage: without it this window is wide enough that the photograph is bound by its
  // height, and the strip stands on its end instead.
  await setHideSidebarInViewer(page, false);
  await openLibrary(page, ROOT);
  await expect(stackFrames(page)).toBeVisible({ timeout: 60_000 });

  // Into the stack, and then into one of its members: a member has no row of its
  // own in the collapsed listing, so this is the case the strip has to place from
  // its band.
  await stackFrames(page).click();
  await frames(bands(page)).first().click();
  // Waited out rather than left running: opening the viewer queues a full-sensor
  // render, and a spec that walks away while one is going hands the next file a
  // server whose scan cannot get a turn.
  await expect(shownFrame(page)).toBeVisible({ timeout: 120_000 });

  await page.getByRole('button', { name: 'Show filmstrip' }).click();
  const strip = gallery(page);
  await expect(strip).toHaveCSS('overflow-x', 'auto');

  const spine = strip.getByRole('listitem').filter({ has: page.getByRole('button', { name: /stack of \d+/, expanded: true }) });
  const member = bands(page).getByRole('listitem').first();
  await expect(spine).toHaveCount(1);
  // The frame the stack's tile would show is the first cell of its band, so it is
  // not drawn twice: no picture, and a bar's width rather than a cell's.
  await expect(spine.locator('img')).toHaveCount(0);
  const bar = await spine.boundingBox();
  const cell = await member.boundingBox();
  if (bar == null || cell == null) throw new Error('the strip has no cells');
  expect(bar.width).toBeLessThan(cell.width / 4);
  // Back the way the band opened, which along the foot is sideways.
  await expect(spine.locator('svg.lucide-chevron-left')).toHaveCount(1);

  // And the photograph on the stage is marked where it actually is, which is
  // inside the band rather than at a cell of the collection.
  await expect(strip.locator('[role="listitem"][aria-current="page"]')).toHaveCount(1);
  await expect(bands(page).locator('[role="listitem"][aria-current="page"]')).toHaveCount(1);

  // The same strip stood on its end: a landscape window leaves the width to spare,
  // so the strip takes the side (`stripEdge`). Everything above holds
  // across the axis - a spine is thin the other way, and the chevron turns with it.
  await page.setViewportSize({ width: 1600, height: 800 });
  await expect(strip).toHaveCSS('overflow-y', 'auto');
  const sideBar = await spine.boundingBox();
  const sideCell = await member.boundingBox();
  if (sideBar == null || sideCell == null) throw new Error('the strip has no cells');
  // Half rather than the quarter the other axis is held to: a cell down the side is
  // as tall as the strip is wide, which is a fraction of how wide one is along the
  // foot, and the spine is the same bar either way.
  expect(sideBar.height).toBeLessThan(sideCell.height / 2);
  await expect(spine.locator('svg.lucide-chevron-up')).toHaveCount(1);
});
