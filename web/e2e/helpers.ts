import { expect, type APIRequestContext, type Browser, type Locator, type Page } from '@playwright/test';
import { z } from 'zod';
import { type RenditionSource } from '../../src/schemas/common';
import {
  CreateLibraryRequestSchema,
  LibrariesSchema,
  LibraryScanStatusSchema,
  type Library,
  type UpdateLibraryRequest,
} from '../../src/schemas/libraries';
import { EditStateSchema } from '../../src/schemas/photo_edits';
import { PhotoListResponseSchema, type PhotoSummary } from '../../src/schemas/photos';
import { PathSegment, route } from '../../src/schemas/route';
import { ShootListSchema } from '../../src/schemas/shoots';
import { type UpdateSettingsRequest, type ViewerRenditionMode } from '../../src/schemas/settings';
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

/**
 * Adds a library, and returns once its import has settled at `photos`.
 *
 * Through the API: a test goes straight to the page it is about, and the one whose subject is
 * adding a library in Settings is `library/indexing.spec.ts`.
 */
export async function addLibrary(
  page: Page,
  rootPath: string,
  options: { autoStack?: boolean; readOnly?: boolean; includeNonRaw?: boolean; photos?: number } = {},
): Promise<void> {
  await forgetLibrary(page, rootPath);
  const created = await page.request.post(route(PathSegment.api(), PathSegment.libraries()), {
    data: {
      root_path: rootPath,
      read_only: options.readOnly === true,
      // Renditions default to a full HDR render, which is minutes of work per frame on the
      // fixture and not what most specs are looking at; the specs that want the render switch
      // back with `setRenditionSource`.
      rendition_source: 'embedded',
      // The fixture is the same ARW copied under several names, so automatic stacking -
      // correctly - collapses the whole library into one tile. Off unless a spec asks for it.
      auto_stack: options.autoStack === true,
      include_non_raw: options.includeNonRaw === true,
    } satisfies z.input<typeof CreateLibraryRequestSchema>,
    timeout: 60_000,
  });
  expect(created.ok(), await created.text()).toBe(true);
  // Waited out rather than stopped: a stop landing before the batch starts leaves the library
  // with no descriptors, and stack detection runs on the settle of the import that *added* the
  // photographs and never again.
  await waitForImport(page, rootPath, options.photos ?? PHOTO_NAMES.length);
}

/**
 * Asked of the API rather than read off the Settings row: nothing on the page watches an import
 * that creating a library started, so the row's Stop never shows for one. The count is part of
 * the answer because a status read before the import has registered is idle too.
 */
async function waitForImport(page: Page, rootPath: string, photos: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const library = await libraryAt(page, rootPath);
        if (library == null) return 'not listed';
        const response = await page.request.get(
          route(PathSegment.api(), PathSegment.libraries(), library.id, PathSegment.sync(), PathSegment.status()),
        );
        const { status } = LibraryScanStatusSchema.parse(await response.json());
        return `${status}, ${library.photo_count} photos`;
      },
      { message: `the import of ${rootPath}`, timeout: 60_000 },
    )
    .toBe(`idle, ${photos} photos`);
}

async function libraryAt(page: Page, rootPath: string): Promise<Library | undefined> {
  const listed = await page.request.get(route(PathSegment.api(), PathSegment.libraries()));
  expect(listed.ok()).toBe(true);
  return LibrariesSchema.parse(await listed.json()).find((library) => library.root_path === rootPath);
}

async function libraryOf(page: Page, rootPath: string): Promise<Library> {
  const library = await libraryAt(page, rootPath);
  if (library == null) throw new Error(`no library is added at ${rootPath}`);
  return library;
}

/** Removes the library an earlier pass of the same spec added, so `--repeat-each` starts each pass fresh. */
export async function forgetLibrary(page: Page, rootPath: string): Promise<void> {
  const held = await libraryAt(page, rootPath);
  if (held == null) return;
  const deleted = await page.request.delete(route(PathSegment.api(), PathSegment.libraries(), held.id));
  expect(deleted.ok()).toBe(true);
}

/** A library's grid, or its Shoots page or Bin, by its address. */
export async function gotoLibrary(page: Page, rootPath: string, within?: 'shoots' | 'bin'): Promise<void> {
  const library = route(PathSegment.libraries(), (await libraryOf(page, rootPath)).id);
  const section = { shoots: route(PathSegment.shoots()), bin: route(PathSegment.bin()) };
  await page.goto(within == null ? library : `${library}${section[within]}`);
}

/** A shoot's grid, by its address, found by the folder it is. */
export async function gotoShoot(page: Page, rootPath: string, folderPath: string): Promise<void> {
  const library = await libraryOf(page, rootPath);
  const listed = await page.request.get(route(PathSegment.api(), PathSegment.libraries(), library.id, PathSegment.shoots()));
  const shoot = ShootListSchema.parse(await listed.json()).find((each) => each.folder_path === folderPath);
  if (shoot == null) throw new Error(`no shoot at ${folderPath} in ${rootPath}`);
  await page.goto(route(PathSegment.shoots(), shoot.id));
}

/**
 * The first photo of a library's grid, opened in the viewer by its address - or a page under it,
 * like the print mockup's - as though from the grid. Returns its id.
 */
export async function gotoPhoto(page: Page, rootPath: string, within = ''): Promise<string> {
  const library = await libraryOf(page, rootPath);
  const photoId = await firstPhotoId(page, rootPath);
  await page.goto(`${route(PathSegment.libraries(), library.id)}${route(PathSegment.photos(), photoId)}${within}`);
  return photoId;
}

/** The photo a library's grid leads with. */
export async function firstPhotoId(page: Page, rootPath: string): Promise<string> {
  const [first] = await libraryPhotos(page, rootPath);
  if (first == null) throw new Error(`the library at ${rootPath} has no photos`);
  return first.id;
}

/** A library's photos, in the order its grid shows them. */
export async function libraryPhotos(page: Page, rootPath: string): Promise<PhotoSummary[]> {
  const library = await libraryOf(page, rootPath);
  const listed = await page.request.get(
    `${route(PathSegment.api(), PathSegment.libraries(), library.id, PathSegment.photos())}?ordering=${library.ordering}`,
  );
  expect(listed.ok()).toBe(true);
  return PhotoListResponseSchema.parse(await listed.json()).photos;
}

/**
 * The library a spec owns, added and imported before its first test.
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
  options: { photos?: number; includeNonRaw?: boolean } = {},
): Promise<void> {
  const page = await browser.newPage();
  // `photos` for a root with a list of its own (`fixture_library.ts`): waiting for
  // the wrong count reads as a library that never arrived.
  await addLibrary(page, rootPath, { includeNonRaw: options.includeNonRaw, photos: options.photos });
  await page.close();
}

/**
 * Points a library at the pixels its renditions are built from. Set before the page under test
 * is opened: a page already open holds the library it loaded.
 */
export async function setRenditionSource(page: Page, rootPath: string, source: RenditionSource): Promise<void> {
  const library = await libraryOf(page, rootPath);
  const response = await page.request.patch(route(PathSegment.api(), PathSegment.libraries(), library.id), {
    data: { rendition_source: source } satisfies UpdateLibraryRequest,
  });
  expect(response.ok()).toBe(true);
}

/** Which rendition the photo viewer opens at, an app-wide setting rather than a per-library one. */
export function setViewerRendition(request: APIRequestContext, mode: ViewerRenditionMode): Promise<void> {
  return patchSettings(request, { viewer_rendition_mode: mode });
}

// On by default, so the stage in the viewer is the window less its margins. A spec
// that measures what the stage's shape does - where the strip sits, whether a
// magnified frame overhangs - turns it off and keeps the sidebar's width in the sum.
export function setHideSidebarInViewer(request: APIRequestContext, hide: boolean): Promise<void> {
  return patchSettings(request, { hide_sidebar_in_viewer: hide });
}

/** The viewer's settings back to a fresh install's. */
export function resetViewerSettings(request: APIRequestContext): Promise<void> {
  return patchSettings(request, {
    viewer_rendition_mode: 'remember',
    last_viewer_rendition: null,
    hide_sidebar_in_viewer: true,
  });
}

export function setOnboardingComplete(request: APIRequestContext, done: boolean): Promise<void> {
  return patchSettings(request, { onboarding_complete: done });
}

async function patchSettings(request: APIRequestContext, settings: UpdateSettingsRequest): Promise<void> {
  const response = await request.patch(route(PathSegment.api(), PathSegment.settings()), { data: settings });
  expect(response.ok()).toBe(true);
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

/**
 * Everything the module says on the console that means the picture is not the one it should be.
 *
 * **A frame arrives either way, which is why this is watched at all.** A dispatch the browser
 * refused writes nothing and the stages after it filter whatever the one before left, so what comes
 * back is a photograph rather than a failure - `gpu.rs`'s uncaptured-error handler is the only thing
 * in a tab that says so. A decode with no noise fit is a frame that was never denoised.
 *
 * Matched on the exact prefixes rather than on `rawshim`, because the module also logs which adapter
 * it opened, and a filter that swept those up would fail every run.
 */
const COMPLAINTS = [
  'rawshim gpu: the browser refused a command',
  'rawshim: no noise fit was measured',
  "rawshim: PMRID's weights have not been handed over",
];

/** Collects those, for a test that asserts none of them arrived. */
export function watchForComplaints(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (COMPLAINTS.some((prefix) => text.startsWith(prefix))) seen.push(text);
  });
  return seen;
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
