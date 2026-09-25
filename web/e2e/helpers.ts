import { expect, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { LibrariesSchema } from '../../src/schemas/libraries';
import { EditStateSchema } from '../../src/schemas/photo_edits';
import { PathSegment, route } from '../../src/schemas/route';
import { PHOTO_NAMES } from './fixture_library';

/**
 * How long to wait on work the server does with pixels.
 *
 * A decode, a rendition build, a thumbnail rebuild: seconds on this fixture, on a machine
 * running the rest of the suite beside it. Everything else takes the config's five seconds,
 * because everything else is a class toggling or a route resolving - which either happens
 * immediately or is broken, and waiting on it only makes a failing suite slow.
 *
 * One name, so raising it raises all of them.
 */
export const FIRST_FRAME = { timeout: 45_000 };

// Navigation the specs share. Libraries are added in Settings and then live
// permanently in the sidebar, so there is no "pick a library" screen to go through.
export function libraryRow(page: Page, rootPath: string) {
  return page.getByRole('list', { name: 'Libraries' }).getByRole('listitem').filter({ hasText: rootPath });
}

export async function addLibrary(
  page: Page,
  rootPath: string,
  options: { autoStack?: boolean; readOnly?: boolean; includeNonRaw?: boolean } = {},
): Promise<void> {
  await forgetLibrary(page, rootPath);
  await page.goto(route(PathSegment.settings()));
  await page.getByRole('button', { name: 'Add library' }).click();
  // The picker writes the folder it opened at into this box, so a path typed
  // before that lands would be overwritten by it.
  const dialog = page.getByRole('dialog', { name: 'Add library' });
  const path = dialog.getByLabel('Library root');
  await expect(path).not.toHaveValue('');
  await path.fill(rootPath);
  if (options.readOnly === true) {
    await dialog.getByRole('checkbox', { name: 'Read-only mode' }).check();
  }
  // Both answered in the dialog rather than PATCHed once the row exists: the import
  // starts as the library lands (§9.8), so either of them written afterwards is
  // racing an import that has already acted on the defaults. A rendition source
  // arrives with a render per photo dispatched, which Stop cannot call back until it
  // has landed; stacking has already grouped the frames, and §19.4 never revisits a
  // photograph imported before it was switched off.
  //
  // Renditions default to a full HDR render, which is minutes of work per frame on
  // the fixture and is not what most specs are looking at; they assert against the
  // embedded JPEG, which the sync lifts straight out of the RAW. The specs that
  // want the render switch back with `setRenditionSource`.
  await dialog.getByRole('combobox', { name: 'Build renditions from' }).click();
  await page.getByRole('option', { name: 'Embedded JPEG' }).click();
  // The fixture is the same ARW copied under several names, so every frame in it
  // is identical to every other and automatic stacking - correctly - collapses
  // the whole library into one tile. That is a property of the fixture rather
  // than of anything most specs are testing, so it is off unless a spec asks for
  // it; `grid/stacks.spec.ts` is the one that does.
  if (options.autoStack !== true) {
    await dialog.getByRole('checkbox', { name: 'Group similar photos automatically' }).uncheck();
  }
  // Off by default, so a root of finished pictures says so: the panorama's views are PNGs,
  // there being no RAW fixture that is a pan.
  if (options.includeNonRaw === true) {
    await dialog.getByRole('checkbox', { name: /Import JPEG, PNG/ }).check();
  }
  // The dialog's own button carries the same name as the one that opened it, so
  // the confirm has to be scoped to the dialog.
  await dialog.getByRole('button', { name: 'Add library' }).click();
  // Creating a library walks the folder before the row can be re-read, so this one is a real
  // wait rather than a render.
  await expect(libraryRow(page, rootPath)).toBeVisible({ timeout: 30_000 });
  // Waited out rather than stopped: with the settings above answered in the dialog
  // the import is building exactly what the spec asked for, and only the grid
  // tiles - a tenth of a second for the whole library. Stopping it was worth it
  // while it was minutes of renders nobody wanted, but a stop landing before the
  // batch starts leaves the library with no descriptors, and stack detection runs
  // on the settle of the import that *added* the photographs and never again.
  await waitForIdle(page, rootPath);
}

/** Removes the library an earlier pass of the same spec added, so `--repeat-each` starts each pass fresh. */
async function forgetLibrary(page: Page, rootPath: string): Promise<void> {
  const libraries = route(PathSegment.api(), PathSegment.libraries());
  const listed = await page.request.get(libraries);
  expect(listed.ok()).toBe(true);
  const held = LibrariesSchema.parse(await listed.json()).find((library) => library.root_path === rootPath);
  if (held == null) return;
  const deleted = await page.request.delete(`${libraries}/${held.id}`);
  expect(deleted.ok()).toBe(true);
}

/**
 * The library a spec owns, added and scanned before its first test.
 *
 * **One root per spec file** (`fixture_library.ts`). The run shares one catalogue
 * and one API, so a spec that rates a photo, bins one, or re-points its library
 * at a different rendition source is writing state the next file would read - and
 * which file that is depends on the order Playwright happens to walk them in.
 * A root of its own is what lets a file be run alone, and lets a failure in one
 * stay there.
 *
 * Setup rather than a first test: a library that never arrived should say so
 * where it happened, rather than as an assertion about something else failing.
 */
export async function useLibrary(
  browser: Browser,
  rootPath: string,
  options: { viewerRendition?: string; hideSidebarInViewer?: boolean; photos?: number; includeNonRaw?: boolean } = {},
): Promise<void> {
  const page = await browser.newPage();
  await addLibrary(page, rootPath, { includeNonRaw: options.includeNonRaw });
  await scanLibrary(page, rootPath);
  // `photos` for a root with a list of its own (`fixture_library.ts`): waiting for
  // the wrong count reads as a library that never arrived.
  await waitForScanSettled(page, rootPath, options.photos ?? PHOTO_NAMES.length);
  // The viewer's own settings are what a root of its own does not isolate: they are
  // global, and the rendition's default - "last used" - is whatever the file before
  // this one happened to choose. A spec that reads what the viewer is showing, or
  // measures the shape it shows it in, says what it needs.
  if (options.viewerRendition != null || options.hideSidebarInViewer != null) {
    await page.goto(route(PathSegment.settings()));
    if (options.viewerRendition != null) await setViewerRendition(page, options.viewerRendition);
    if (options.hideSidebarInViewer != null) await setHideSidebarInViewer(page, options.hideSidebarInViewer);
  }
  await page.close();
}

// Settings is a five-tab page; open the tab a control lives on before reaching
// for it. Idempotent, so a spec that is already on the right tab pays nothing.
async function openSettingsTab(page: Page, name: string): Promise<void> {
  const tab = page.getByRole('radio', { name });
  if ((await tab.getAttribute('aria-checked')) !== 'true') await tab.click();
}

// Folders / renditions / stacks sit behind this disclosure so Settings stays
// short; open it before touching any of those controls.
async function openLibrarySettings(page: Page, rootPath: string): Promise<void> {
  const details = libraryRow(page, rootPath)
    .locator('details')
    .filter({ has: page.locator('summary', { hasText: 'Library settings' }) });
  if (!(await details.evaluate((el) => (el as HTMLDetailsElement).open))) {
    await details.locator('summary').click();
  }
  await expect(details).toHaveAttribute('open', '');
}

// Points a library at the pixels its renditions are built from. The control is a
// Select, whose trigger is a combobox named after the setting rather than a
// button named after the value, so the value is picked from the menu it opens.
export async function setRenditionSource(page: Page, rootPath: string, source: string): Promise<void> {
  // Specs interleave this with the Viewing-tab helpers below, so the tab a
  // library's own controls sit on cannot be assumed to already be open.
  await openSettingsTab(page, 'Libraries');
  await openLibrarySettings(page, rootPath);
  await libraryRow(page, rootPath).getByRole('combobox', { name: 'Build renditions from' }).click();
  await page.getByRole('option', { name: source }).click();
}

// Which rendition the photo viewer opens at, an app-wide setting rather than a
// per-library one. Same shape of control as above, and named for the question it
// answers rather than for the answer currently showing.
export async function setViewerRendition(page: Page, rendition: string): Promise<void> {
  await openSettingsTab(page, 'Viewing');
  await page.getByRole('combobox', { name: 'Default viewer rendition' }).click();
  await page.getByRole('option', { name: rendition, exact: true }).click();
}

// On by default, so the stage in the viewer is the window less its margins. A spec
// that measures what the stage's shape does - where the strip sits, whether a
// magnified frame overhangs - turns it off and keeps the sidebar's width in the sum.
export async function setHideSidebarInViewer(page: Page, hide: boolean): Promise<void> {
  await openSettingsTab(page, 'Viewing');
  const box = page.getByRole('checkbox', { name: 'Hide sidebar automatically in photo viewer' });
  // Clicked and then waited for, rather than `setChecked`: the box is drawn from what
  // the server answered, so it is still holding the old value when the click returns.
  if ((await box.isChecked()) !== hide) await box.click();
  await expect(box).toBeChecked({ checked: hide });
}

export async function setOnboardingComplete(request: APIRequestContext, done: boolean): Promise<void> {
  const response = await request.patch(route(PathSegment.api(), PathSegment.settings()), {
    data: { onboarding_complete: done },
  });
  expect(response.ok()).toBe(true);
}

export async function scanLibrary(page: Page, rootPath: string): Promise<void> {
  await page.goto(route(PathSegment.settings()));
  await libraryRow(page, rootPath).getByRole('button', { name: 'Scan library' }).click({ timeout: 60_000 });
}

// Returns once the row has taken a run up and settled again, which it says by
// offering Scan library again. Stop and Scan library share a slot, so a spec that selected
// Scan library while a run was going would hit Stop instead.
//
// The run is waited for from its *start*, not from its result: a photo count, a
// tile or a row all appear while the scan is still going, so anything that reads
// one of those as "finished" is reading a signal the run wrote on its way past.
async function waitForIdle(page: Page, rootPath: string): Promise<void> {
  // The status is reported from the poll rather than from the request's answer, so
  // the button takes a tick to appear. Not an assertion: a run short enough to be
  // over before the first poll has nothing left to wait for.
  await libraryRow(page, rootPath)
    .getByRole('button', { name: 'Stop' })
    .waitFor({ state: 'visible', timeout: 5_000 })
    .catch(() => {});
  await expect(libraryRow(page, rootPath).getByRole('button', { name: 'Scan library' })).toBeVisible({ timeout: 60_000 });
}

// Waits on the Settings page until the run has finished and the catalogue has
// been re-read. A spec that navigates away before then takes the grid it happens
// to catch mid-run: fine when it is only waiting for tiles, which arrive by
// announcement, and not fine when it is waiting on something that changes the
// shape of the collection (§19.4.1) - a re-read landing after the grid was opened
// drops whatever was unfolded in it.
export async function waitForScanSettled(page: Page, rootPath: string, photos: number): Promise<void> {
  await waitForIdle(page, rootPath);
  await expect(libraryRow(page, rootPath)).toContainText(`${photos} photo`, { timeout: 60_000 });
}

// From the library's Shoots page. Where the shoot goes is the row its + menu was
// opened from, so a root-level one comes from the library root's own menu.
export async function addShoot(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add to the library root' }).click();
  await page.getByRole('menuitem', { name: 'Create shoot in subfolder' }).click();
  await page.getByLabel('Shoot name').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create shoot' }).click();
}

// The sidebar lists every library by its folder name, with the full path as the
// title, which is the only unambiguous handle when two share a basename.
//
// Waited for before it is clicked, so a sidebar that never fills names the library it was
// waiting for. A bare click reports only that a locator was still being waited on, which is
// the same message whether the page was slow, the library was never created, or an earlier
// test removed it - and under load this is where the suite lands when it lands anywhere.
//
// The wait is the slow half and says so; the click that follows takes the default, because by
// then the element is on the page and a click that cannot land in five seconds is a broken
// test rather than a slow one.
export async function openLibrary(page: Page, rootPath: string): Promise<void> {
  const link = sidebarLibrary(page, rootPath);
  await expect(link, `the sidebar should list ${rootPath}`).toBeVisible({ timeout: 30_000 });
  await link.click();
}

/** A library's link in the sidebar, which describes itself with its root. */
export function sidebarLibrary(page: Page, rootPath: string): Locator {
  return page.getByRole('navigation', { name: 'Sidebar' }).locator(describedBy(rootPath));
}

// Every library in the sidebar lists Photos / Shoots / Bin, so the section has to be
// asked for by library: the run shares one catalogue and earlier specs leave their
// libraries in it, and a bare "Shoots" link matches every one of them.
export function sidebarSection(page: Page, rootPath: string, name: 'Photos' | 'Shoots' | 'Bin') {
  return page
    .getByRole('navigation', { name: 'Sidebar' })
    .getByRole('group')
    .filter({ has: page.locator(describedBy(rootPath)) })
    .getByRole('link', { name, exact: true });
}

function describedBy(description: string): string {
  return `[aria-description=${JSON.stringify(description)}]`;
}

// Maintenance actions on the selection live behind the bulk bar's overflow, so
// the bar's own row holds only what the selection becomes (§18.3.1).
// Exact, because "Stack" is a substring of "Unstack" and a name match is one by
// default.
export async function bulkAction(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}

// Filing into a shoot is a submenu, so it takes two rows: the trigger, named for
// whether the selection is already in a shoot, and then the shoot itself.
// Both labels in full rather than the "shoot" they share a tail with: "Remove from
// Product shoot" sits in the same section, and a shoot named for one is ordinary.
export async function fileIntoShoot(page: Page, folderPath: string): Promise<void> {
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /^(Add to shoot|Move to another shoot)$/ }).click();
  await page.getByRole('menuitem', { name: folderPath, exact: true }).click();
}

// How the grid is drawn lives behind the header's overflow: the modes are a segmented
// control inside it, so the menu has to be open before one can be pressed (§18.3.1).
export async function setViewMode(page: Page, mode: 'Grid' | 'Masonry' | 'List'): Promise<void> {
  await page.getByRole('button', { name: 'Grid options' }).click();
  await page.getByRole('button', { name: mode, exact: true }).click();
  await page.keyboard.press('Escape');
}

// A box that stays ticked, so the menu is left open by the click and closed by hand.
export async function toggleExpandStacks(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Grid options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Expand all stacks' }).click();
  await page.keyboard.press('Escape');
}

// Row housekeeping lives behind the ⋮ menu; a click on the name opens the shoot.
export async function shootAction(page: Page, shootName: string, action: string): Promise<void> {
  await shootRow(page, shootName).getByRole('button', { name: `Actions for ${shootName}` }).click();
  await page.getByRole('menuitem', { name: action }).click();
}

export async function openShoot(page: Page, shootName: string): Promise<void> {
  await shootRow(page, shootName).getByText(shootName, { exact: true }).click();
}

// The Shoots and Albums lists, which name themselves by how many rows they hold.
export function collectionList(page: Page): Locator {
  return page.getByRole('list', { name: /^\d+ rows$/ });
}

export function shootRow(page: Page, shootName: string): Locator {
  return collectionList(page).getByRole('listitem').filter({ hasText: shootName });
}

// The grid's photographs, or the filmstrip's beside an open photo: both name themselves by
// their row count.
export function gallery(page: Page): Locator {
  return page.getByRole('list', { name: /^\d+ photos$/ });
}

// A cell of the collection, or a member of a band open under one.
export function tiles(page: Page): Locator {
  return gallery(page).getByRole('listitem');
}

// The collection's own rows, which a band's members are not: they have no position in it.
export function rowTiles(page: Page): Locator {
  return gallery(page).locator('[role="listitem"][aria-posinset]');
}

export function bands(page: Page): Locator {
  return gallery(page).getByRole('group', { name: /\d+ photos in this stack|\d+ frames of this (panorama|merge)/ });
}

const FRAME = /^(selected, )?(photo |stack of \d+, photo |panorama of \d+ photos|merge of \d+ photos)/;

// What a click on the picture lands on: a link into the photograph, or a stack's disclosure.
export function frames(scope: Page | Locator): Locator {
  return scope.getByRole('link', { name: FRAME }).or(scope.getByRole('button', { name: FRAME }));
}

export function stackFrames(scope: Page | Locator): Locator {
  return scope.getByRole('button', { name: /stack of \d+, photo / });
}

export function picks(scope: Page | Locator): Locator {
  return scope.getByRole('checkbox', { name: /^Select photo / });
}

export function selectedTiles(page: Page): Locator {
  return gallery(page).getByRole('checkbox', { name: /^Select photo /, checked: true });
}

export function cursorTile(page: Page): Locator {
  return gallery(page).locator('[role="listitem"][aria-current="true"]');
}

// Which of the first `count` of these tiles are ticked, in order.
export function ticked(cells: Locator, count: number): Promise<boolean[]> {
  return Promise.all(Array.from({ length: count }, (_, i) => picks(cells.nth(i)).isChecked()));
}

// A band joined to the tile that opened it draws the bridge across the row gap as its `::before`.
export function fusedBands(page: Page): Promise<number> {
  return bands(page).evaluateAll((all) => all.filter((band) => getComputedStyle(band, '::before').content !== 'none').length);
}

export function selectionBar(page: Page): Locator {
  return page.getByRole('group', { name: 'Selection' });
}

export function selectionCount(page: Page): Locator {
  return selectionBar(page).getByText(/selected$/);
}

// The filename a tile's tick box is named for.
export async function tileName(tile: Locator): Promise<string> {
  return ((await picks(tile).getAttribute('aria-label')) ?? '').replace(/^Select photo /, '');
}

// A tile's frame opens the photo on one click, and its tick box is what starts a
// selection (§18.3.1) - so a spec that wants one or the other says which.
export function openPhoto(page: Page, nth = 0): Promise<void> {
  return frames(page).nth(nth).click();
}

export function selectPhoto(page: Page, nth = 0): Promise<void> {
  return picks(page).nth(nth).click();
}

// The viewer's URL also names the collection the photo was opened from, so the
// id is the last path segment rather than the tail of the whole URL.
export function openPhotoId(page: Page): string {
  return new URL(page.url()).pathname.split('/').pop() ?? '';
}

const IMAGE_PHOTO_ID = new RegExp(`${route(PathSegment.image())}/([^/]+)/`);

export function photoIdOfImageUrl(src: string | null): string {
  return IMAGE_PHOTO_ID.exec(src ?? '')?.[1] ?? '';
}

// A click on the picture walks the stops - fitted, twice fitted, the frame's own
// pixels, round to fitted - which is the whole of the zoom outside the menu's slider.
export function stepZoom(page: Page): Promise<void> {
  return photoStage(page).click();
}

// Every menu the viewer offers is one popup under one button, on every screen, so
// picking any of them is this and then the item - under its own heading, because
// each rendition is named twice in there: once to look at, once to download.
export async function photoAction(page: Page, section: string, name: string, options?: { exact?: boolean }): Promise<void> {
  await page.getByRole('button', { name: 'More' }).click();
  await page.getByRole('group', { name: section }).getByRole('menuitem', { name, exact: options?.exact }).click();
}

/**
 * A display that shows light past SDR white, which headless Chromium says it is not. Patched into
 * the page rather than emulated: `Emulation.setEmulatedMedia` leaves `dynamic-range` alone.
 */
export async function emulateHdrDisplay(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const answer = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const list = answer(query);
      return query === '(dynamic-range: high)' ? Object.create(list, { matches: { value: true } }) : list;
    };
  });
}

/**
 * The kind of context each canvas on the GPU worker took, one entry per canvas in the order they
 * took one: a canvas the page has handed over can no longer be asked on the page. Set up before
 * the page loads, which is when the worker starts.
 */
export async function recordCanvasContexts(page: Page): Promise<() => Promise<string[]>> {
  await page.route(/\/gpu_worker\.ts(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `
        const canvasContexts = [];
        const counted = new WeakSet();
        Object.defineProperty(globalThis, 'canvasContexts', { get: () => canvasContexts });
        const getCanvasContext = OffscreenCanvas.prototype.getContext;
        OffscreenCanvas.prototype.getContext = function (kind, ...rest) {
          const context = getCanvasContext.call(this, kind, ...rest);
          if (context != null && !counted.has(this)) {
            counted.add(this);
            canvasContexts.push(kind);
          }
          return context;
        };
        ${await response.text()}
      `,
    });
  });
  return async () => {
    const worker = page.workers().find((each) => each.url().includes('gpu_worker'));
    if (worker == null) throw new Error('The GPU worker was not created');
    return z.array(z.string()).parse(await worker.evaluate(() => Reflect.get(globalThis, 'canvasContexts')));
  };
}

/** Chooses a proof from the bar's soft proof menu, or from its overflow menu on a phone. */
export async function softProof(page: Page, proof: string): Promise<void> {
  const button = page.getByRole('button', { name: /^Soft proof/ });
  await ((await button.count()) > 0 ? button : page.getByRole('button', { name: 'More', exact: true })).click();
  await page.getByRole('menuitem', { name: proof, exact: true }).click();
}

// Panels start closed; tests that read them have to ask. Waits for the toggle so
// a call right after openPhoto cannot no-op before DetailNav mounts, and skips
// the click when a prior toggle in this context already left them open.
export async function showMetadata(page: Page): Promise<void> {
  const show = page.getByRole('button', { name: 'Show metadata' });
  const hide = page.getByRole('button', { name: 'Hide metadata' });
  await expect(show.or(hide)).toBeVisible();
  if (await show.isVisible()) await show.click();
}

// Opens the first photo and swaps the rendition for the full-resolution render,
// which the server builds on first request.
export async function viewMaxQuality(page: Page, rootPath: string): Promise<void> {
  await page.goto(route(PathSegment.settings()));
  await openLibrary(page, rootPath);
  await openPhoto(page);
  // The full-size rendition is built by the background queue after a sync, so a
  // freshly synced library can wait on a real decode here.
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });

  await photoAction(page, 'Rendition', 'Rendered RAW (max quality)');
  await showMetadata(page);
  await expect(renditionDetails(page).getByText('Rendered RAW (max quality)')).toBeVisible({
    timeout: 180_000,
  });
  // The stage holds the previous frame until the new one has decoded, so the
  // panel naming the rendition is not yet the image carrying it.
  await expect(shownFrame(page)).toHaveAccessibleName(/Rendered RAW \(max quality\)$/, { timeout: 60_000 });
}

// Split triage mounts two; everywhere else there is one. Exact, or 'Photo details' matches too.
export function photoStage(page: Page): Locator {
  return page.getByRole('region', { name: 'Photo', exact: true });
}

// Only the frame on screen is exposed; its neighbours and a leaving picture are hidden.
// Named for its file and rendition: `/Embedded JPEG$/`, `/Rendered RAW$/`, `/\(max quality\)$/`.
export function shownFrame(page: Page): Locator {
  return photoStage(page).getByRole('img');
}

export async function shownFilename(page: Page): Promise<string> {
  const name = await shownFrame(page).getAttribute('aria-label');
  return name?.split(', ')[0] ?? '';
}

export function renditionDetails(page: Page): Locator {
  return page.getByRole('group', { name: 'Rendition details' });
}

export function editPreview(page: Page): Locator {
  return photoStage(page).getByRole('img', { name: 'Edit preview' });
}

/**
 * The editor's hidden readout of what no control shows: `data-adapter`, `data-size` (the prepared
 * frame), `data-stage` (the canvas backing size asked of the worker) and `data-matched`.
 */
export function editDiagnostics(page: Page): Locator {
  return page.getByTestId('raw-edit-diagnostics');
}

/** A `WxH` diagnostic, as numbers; zero where it is not there yet. */
export async function editDiagnosticSize(page: Page, name: 'data-size' | 'data-stage'): Promise<[number, number]> {
  const [width = 0, height = 0] = ((await editDiagnostics(page).getAttribute(name)) ?? '0x0').split('x').map(Number);
  return [width, height];
}

// The tool picker is the editor's own, so it is there exactly while the editor is.
export function editTools(page: Page): Locator {
  return page.getByRole('radiogroup', { name: 'Tool' });
}

/** Why the editor has no picture, over the stage where it would be. */
export function editorFailure(page: Page): Locator {
  return page.getByRole('alert').filter({ hasText: "We couldn't show this photo." });
}

/** Waits for the editor's picture to be live, throwing the reason the stage gives if the open failed. */
export async function waitForEditorLive(page: Page, timeout = 170_000): Promise<void> {
  // `has` resolves relative to the stage, so the preview is named from the page, not via `editPreview`.
  const stage = photoStage(page).filter({ has: page.getByRole('img', { name: 'Edit preview' }) });
  const failure = editorFailure(page);
  await expect
    .poll(
      async () => {
        // Busy before failure: the stage stops being busy on a failure too, in the render that
        // brings its text, so the other order can read a failed open as a live one.
        const busy = await stage.getAttribute('aria-busy', { timeout: 1_000 }).catch(() => null);
        if (await failure.isVisible()) throw new Error(await failure.innerText());
        return busy;
      },
      { timeout },
    )
    .toBe('false');
}

/** The revision the server holds a photograph's edits at, which a save that landed moves. */
export async function savedRev(page: Page, photoId: string): Promise<number> {
  const response = await page.request.get(route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.edits()));
  return EditStateSchema.parse(await response.json()).rev;
}
