import { expect, test } from '@playwright/test';
import { CULL_PHOTOS_DIR, PHOTO_NAMES } from './fixture_library';
import { addLibrary, openLibrary, syncLibrary, viewOriginal } from './helpers';

// This spec has its own library root, so binning and rejecting here cannot
// disturb the counts the other spec asserts.
test.describe.configure({ mode: 'serial' });

test('sync indexes the cull library', async ({ page }) => {
  await addLibrary(page, CULL_PHOTOS_DIR);
  await syncLibrary(page, CULL_PHOTOS_DIR);
  await openLibrary(page, CULL_PHOTOS_DIR);
  // Waits on a real scan, so it needs longer than the configured 15s default.
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length, { timeout: 45_000 });
});

test('rating and picking work from the grid without opening a photo', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  // Arrow to the first tile, rate it, pick it. The whole point is that culling
  // never requires a round trip through the detail view.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tile--focused')).toHaveCount(1);
  await page.keyboard.press('4');
  await page.keyboard.press('c');

  const first = page.locator('.tile').first();
  await expect(first.locator('.verdict__btn--pick.is-on')).toBeVisible();
  await expect(first.locator('.rating button.on')).toHaveCount(4);

  // The verdict survives a reload, so it was persisted rather than only shown.
  await page.reload();
  await expect(first.locator('.rating button.on')).toHaveCount(4);
  await expect(first.locator('.verdict__btn--pick.is-on')).toBeVisible();
});

test('the verdict and rating on a tile are clickable, and clicking again clears them', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  const tile = page.locator('.tile').nth(1);

  // Setting a verdict from the grid must not open the photo: these controls are
  // the whole reason a cull does not need the detail view.
  await tile.getByRole('button', { name: 'Pick' }).click();
  await expect(tile.locator('.verdict__btn--pick.is-on')).toBeVisible();
  expect(page.url()).not.toContain('/photos/');

  await tile.getByRole('button', { name: 'Clear pick' }).click();
  await expect(tile.locator('.verdict__btn--pick.is-on')).toHaveCount(0);

  await tile.getByRole('button', { name: 'Set rating to 3' }).click();
  await expect(tile.locator('.rating button.on')).toHaveCount(3);
  // Clicking the star it already sits on is how a rating is removed.
  await tile.getByRole('button', { name: 'Set rating to 3' }).click();
  await expect(tile.locator('.rating button.on')).toHaveCount(0);
});

test('rejecting removes a photo from the default working set', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  // The gallery opens on Active (untriaged + picked), so a reject should leave
  // the view immediately rather than lingering in the set being worked through.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x');
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length - 1);

  await page.getByRole('button', { name: 'Rejects', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);
  await expect(page.locator('.verdict__btn--reject.is-on')).toHaveCount(1);

  // Undo the reject so later tests see the full set again.
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('x');
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

test('the Picks filter narrows to what was picked', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.getByRole('button', { name: 'Picks', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);

  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

test('filename search finds a single frame', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.getByLabel('Find by filename').fill('alpha');
  await expect(page.locator('.tile')).toHaveCount(1);
  await expect(page.locator('.tile__name').first()).toHaveText('alpha.arw');
});

test('a search cleared from outside the box stays cleared', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  const box = page.getByLabel('Find by filename');

  await box.fill('alpha');
  await expect(page.locator('.tile')).toHaveCount(1);

  // Regression: the box kept its own copy of the text and its debounce compared
  // that stale copy against the freshly emptied store, writing the old search
  // back 250ms later. Opening another collection resets the filters, which is
  // exactly that external clear. Waiting past the debounce is the point.
  await page.getByRole('link', { name: 'Bin', exact: true }).click();
  await expect(box).toHaveValue('');
  await page.waitForTimeout(600);
  await expect(box).toHaveValue('');
  await expect(page.locator('.tile')).toHaveCount(0);
});

test('the Custom filter unions its options instead of intersecting them', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  // A preset is a named point in the same space as Custom, so it arrives with
  // its own options already ticked. Start from All, which ticks nothing, or the
  // clicks below would be toggling the Active preset's boxes off.
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: /^Custom/ }).click();
  await expect(page.getByRole('menuitemcheckbox', { checked: true })).toHaveCount(0);

  // One photo is picked and rated by an earlier test; the rest are neither. As an
  // intersection "picks AND unrated" is empty, so a union is the only reading
  // that returns the whole set.
  await page.getByRole('menuitemcheckbox', { name: 'Picks' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Unrated' }).click();
  await page.keyboard.press('Escape');

  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

test('a preset filter arrives with its options already ticked in Custom', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  // Active is untriaged + picked, so Custom must show exactly those two ticked
  // rather than looking as though no filter were applied.
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await page.getByRole('button', { name: /^Custom/ }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Untriaged', checked: true })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Picks', checked: true })).toBeVisible();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Rejects', checked: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Delete bins the focused photo and the toast undoes it', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  // Wait for the grid: a keypress before the photos land finds nothing to focus.
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.tile--focused')).toHaveCount(1);
  const binned = await page.locator('.tile__name').first().innerText();
  await page.keyboard.press('Delete');

  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length - 1);
  await expect(page.getByText('1 photo moved to the Bin')).toBeVisible();

  // Undo must actually put it back, not just dismiss the toast.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
  await expect(page.locator('.tile__name', { hasText: binned })).toBeVisible();
});

test('restoring from the Bin returns the photo to the library', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);

  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await page.getByRole('button', { name: 'Move to Bin' }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length - 1);

  await page.getByRole('link', { name: 'Bin', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(1);
  // Regression: the Bin used to hold thumbnail-less grey boxes because
  // soft-delete removed the WebPs, making it impossible to find anything.
  await expect(page.locator('.tile__pending')).toHaveCount(0);

  // Regression: the Bin used to offer add-to-shoot, which always failed with
  // "photos not found" because deleted rows are excluded from that lookup.
  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await expect(page.getByRole('button', { name: 'Add to shoot' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Restore to original location' }).click();
  await expect(page.locator('.tile')).toHaveCount(0);

  await page.getByRole('link', { name: 'Photos', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);
});

test('the detail view shows shooting metadata, the triage control and steps between photos', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();

  // Body and lens lead the camera panel; everything else is one click away, so
  // each panel costs the same few lines however much the camera recorded.
  const camera = page.locator('.panel', { hasText: 'CAMERA' });
  await expect(camera.locator('.meta dt')).toHaveCount(2);
  await expect(camera.getByText('Body', { exact: true })).toBeVisible();
  await expect(camera.getByText('Lens', { exact: true })).toBeVisible();

  // ISO/shutter/aperture/focal are read from the RAW header; the fixture has them.
  await camera.getByRole('button', { name: /more/ }).click();
  await expect(camera.getByText('ISO', { exact: true })).toBeVisible();
  await expect(camera.getByText('Shutter', { exact: true })).toBeVisible();
  await expect(camera.getByText('Aperture', { exact: true })).toBeVisible();

  // Three-way triage, not a checkbox: "undecided" has to be expressible.
  const triage = page.locator('.ui-seg--stretch');
  await expect(triage.getByRole('button', { name: 'Reject' })).toBeVisible();
  await expect(triage.getByRole('button', { name: 'Undecided' })).toBeVisible();
  await expect(triage.getByRole('button', { name: 'Pick' })).toBeVisible();

  // The served thumbnail reports where its pixels came from and how it was encoded.
  const thumbnail = page.locator('.panel', { hasText: 'THUMBNAIL ON SCREEN' });
  await expect(thumbnail.getByText('Source', { exact: true })).toBeVisible();
  await thumbnail.getByRole('button', { name: /more/ }).click();
  await expect(thumbnail.getByText('WEBP')).toBeVisible();

  const path = page.locator('.detail__nav .ui-text--mono');
  const first = await path.innerText();
  await page.getByRole('button', { name: 'Next photo' }).click();
  await expect(path).not.toHaveText(first);
});

test('a selection can be rebuilt from the embedded JPEG', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await expect(page.locator('.tile')).toHaveCount(PHOTO_NAMES.length);

  await page.getByRole('button', { name: 'Select photo' }).first().click();
  await page.getByRole('button', { name: 'Rebuild' }).click();
  await page.getByRole('menuitem', { name: 'Thumbnails from the embedded JPEG' }).click();
  await expect(page.getByText(/Rebuilding 1 thumbnail from the embedded JPEG/)).toBeVisible();

  // The source is recorded per photo, so the detail view can say which pixels are
  // on screen rather than leaving the user to guess.
  await page.locator('.tile__hit').first().click();
  const thumbnail = page.locator('.panel', { hasText: 'THUMBNAIL ON SCREEN' });
  await expect(thumbnail.getByText('embedded JPEG')).toBeVisible({ timeout: 30_000 });
});

// Playwright's stock Chromium has JPEG XL compiled in but switched off, which is
// what every browser without native support looks like to the viewer. The
// native path is covered by native_jxl.spec.ts, which needs its own worker.
test('View original decodes the JXL with wasm where the browser has no native support', async ({ page }) => {
  await viewOriginal(page, CULL_PHOTOS_DIR);

  // The stage can only show this if the wasm decode and the PNG transcode both
  // worked: the src becomes a blob.
  const shown = page.locator('.stage__viewport img');
  expect(await shown.evaluate((i: HTMLImageElement) => i.src.startsWith('blob:'))).toBe(true);
  // Full resolution, not the 3840-edge preview it replaced.
  expect(await shown.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(3840);

  // Leaving the view must release the blob; a full-resolution PNG is hundreds of
  // megabytes and an object URL keeps it alive for the life of the document.
  await page.getByRole('button', { name: 'Back to preview' }).click();
  await expect(shown).toHaveAttribute('src', /^http/);
});

test('the stage never shows the previous photo after navigating to another one', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();

  // Regression: the store deliberately keeps the previous detail while the next
  // loads (so the rail doesn't collapse), which made the stage paint the frame
  // before for a beat. The visible image must always be the one in the URL.
  await page.getByRole('button', { name: 'Next photo' }).click();
  const mismatch = await page.evaluate(() => {
    const img = document.querySelector<HTMLImageElement>('.stage__viewport img');
    if (img == null) return 'no image';
    const shown = img.classList.contains('is-ready');
    const id = location.pathname.split('/').pop();
    return shown && !img.src.includes(id ?? '') ? `showing ${img.src} on ${id}` : null;
  });
  expect(mismatch).toBeNull();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();
});

test('the photo fits the stage instead of overflowing it', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img')).toBeVisible();

  // Regression: as a grid item the image grew the row to its own height, so
  // `height: 100%` resolved against that and tall frames were cropped.
  const fits = await page.locator('.stage__viewport').evaluate((vp) => {
    const img = vp.querySelector('img');
    if (img == null) return false;
    return img.getBoundingClientRect().height <= vp.clientHeight + 1;
  });
  expect(fits).toBe(true);
});

test('clicking zooms into the point clicked, not the centre', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();

  // Regression: the zoom-about-point maths ran inside a setScale updater and
  // called setOffset from within it. React re-invokes updaters, so the offset was
  // applied about twice and the clicked detail slid away from the cursor.
  const drift = await page.locator('.stage__viewport').evaluate(async (vp) => {
    const img = vp.querySelector('img');
    if (img == null) return null;
    const box = vp.getBoundingClientRect();
    const fit = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
    const read = (): { x: number; y: number; s: number } => {
      const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(img.style.transform);
      return m == null ? { x: 0, y: 0, s: 1 } : { x: +m[1]!, y: +m[2]!, s: +m[3]! };
    };
    // Which point of the photo sits under a screen coordinate, 0..1.
    const fraction = (px: number, py: number): { x: number; y: number } => {
      const t = read();
      const w = img.naturalWidth * fit * t.s;
      const h = img.naturalHeight * fit * t.s;
      return {
        x: (px - (box.left + box.width / 2 + t.x - w / 2)) / w,
        y: (py - (box.top + box.height / 2 + t.y - h / 2)) / h,
      };
    };
    // Off-centre but well inside the pan limits, so the clamp cannot mask this.
    const px = box.left + box.width * 0.5;
    const py = box.top + box.height * 0.62;
    const before = fraction(px, py);
    img.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: px, clientY: py }));
    await new Promise((r) => setTimeout(r, 200));
    const after = fraction(px, py);
    return { zoomed: read().s > 1, dx: Math.abs(after.x - before.x), dy: Math.abs(after.y - before.y) };
  });

  expect(drift?.zoomed).toBe(true);
  expect(drift?.dx).toBeLessThan(0.01);
  expect(drift?.dy).toBeLessThan(0.01);
});

test('panning a zoomed photo cannot drag it off the stage', async ({ page }) => {
  await page.goto('/settings');
  await openLibrary(page, CULL_PHOTOS_DIR);
  await page.locator('.tile__hit').first().click();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible();

  await page.getByRole('button', { name: 'Zoom in' }).click();
  const viewport = page.locator('.stage__viewport');
  const box = (await viewport.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // Drag far past any legal offset. Unclamped this left the photo detached from
  // the viewport edge, showing empty background where the image should be.
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 4000, cy + 4000, { steps: 5 });
  await page.mouse.up();

  const gap = await viewport.evaluate((vp) => {
    const img = vp.querySelector('img');
    if (img == null) return -1;
    const i = img.getBoundingClientRect();
    const v = vp.getBoundingClientRect();
    // How far the image's leading edges sit inside the viewport. A zoomed photo
    // is larger than the stage, so this can never legitimately be positive.
    return Math.max(i.left - v.left, i.top - v.top);
  });
  expect(gap).toBeLessThanOrEqual(1);
});
