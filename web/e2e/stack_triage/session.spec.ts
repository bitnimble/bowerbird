import { expect, test, type Locator, type Page } from '@playwright/test';
import { PathSegment, route } from '../../../src/schemas/route';
import { API_URL, TRIAGE_PHOTO_NAMES, TRIAGE_PHOTOS_DIR, stackPhotosUrl } from '../fixture_library';
import {
  addLibrary,
  bands,
  frames,
  openLibrary,
  openPhotoId,
  photoStage,
  shownFrame,
  stackFrames,
} from '../helpers';

// Stack triage, driven through the real screen (DESIGN §20).
//
// Its own library, because the tournament writes triage over every member and the
// stacks spec counts on theirs being untouched. More than two frames: two is a
// single round, which cannot show a winner being held over, a second entry in the
// queue, or a rewind to anything but the start.
//
// Serial, because each test leaves the catalogue where the next one starts.
test.describe.configure({ mode: 'serial' });

const TRIAGE_DIR = TRIAGE_PHOTOS_DIR;

// The verdicts as the catalogue holds them, which is what a session is for. Read
// through the API rather than off the screen: the point is that the photographs
// carry them once the session is over, not that a count on the screen agreed.
//
// The stack's own members, not the library listing, which collapses a stack to
// one row (§19.5.1) and would report a single verdict for all three.
async function countOf(page: Page, stackId: string, triage: string): Promise<number> {
  const response = await page.request.get(stackPhotosUrl(stackId));
  if (!response.ok()) return -1;
  const members = (await response.json()) as { triage: string }[];
  return members.filter((member) => member.triage === triage).length;
}

// The session's own stack, taken from the route it is running on.
function stackIdOf(page: Page): string {
  return new RegExp(`${route(PathSegment.stacks())}/([^/]+)${route(PathSegment.triage())}`).exec(page.url())?.[1] ?? '';
}

// Puts every member back to untriaged.
//
// A session captures each member's verdict as the baseline every undo restores
// to, so a test inheriting the previous one's rejections inherits them as the
// *correct* answer and its absolute counts stop meaning anything. Cheaper than
// giving each test its own library, and it keeps them independent of each other's
// verdict order.
async function clearVerdicts(page: Page): Promise<void> {
  const libraries = await page.request.get(`${API_URL}${route(PathSegment.api(), PathSegment.libraries())}`);
  const list = (await libraries.json()) as { id: string; root_path: string }[];
  const library = list.find((entry) => entry.root_path === TRIAGE_DIR);
  if (library == null) return;
  const rows = await page.request.get(
    `${API_URL}${route(PathSegment.api(), PathSegment.libraries(), library.id, PathSegment.photos())}?limit=200&include_deleted=true`,
  );
  const { photos } = (await rows.json()) as { photos: { id: string; stack_id: string | null }[] };
  const stackId = photos.find((photo) => photo.stack_id != null)?.stack_id;
  if (stackId == null) return;
  const members = (await (await page.request.get(stackPhotosUrl(stackId))).json()) as { id: string }[];
  for (const member of members) {
    await page.request.patch(`${API_URL}${route(PathSegment.api(), PathSegment.photos(), member.id)}`, {
      data: { triage: 'untriaged' },
    });
  }
}

// Named for the pool it holds as well: `Queue (4)`.
function queueButton(page: Page): Locator {
  return page.getByRole('button', { name: /^Queue/ });
}

function shown(page: Page): Promise<string | null> {
  return shownFrame(page).getAttribute('aria-label', { timeout: 10_000 });
}

// Opens a member of the stack in the viewer, which is the only way in (§20.5).
async function enterTriage(page: Page): Promise<void> {
  await clearVerdicts(page);
  await openLibrary(page, TRIAGE_DIR);
  await expect(stackFrames(page)).toBeVisible({ timeout: 45_000 });
  // A stack's tile opens its band rather than the photo, so the way to a member's
  // detail view is through the band.
  await stackFrames(page).click();
  await expect(bands(page).getByRole('listitem')).toHaveCount(TRIAGE_PHOTO_NAMES.length);
  await frames(bands(page)).first().click();

  await page.getByRole('button', { name: 'Triage stack' }).click();
  await expect(page.getByRole('button', { name: 'Pick A' })).toBeVisible();
  // Judgeable, not merely on screen: the keys and the buttons are both dead until *both*
  // frames of the round are up, and a press into that window is dropped rather than queued.
  // One visible frame is the first of the pair, so waiting on that alone leaves every test
  // here racing the second one's decode.
  await expect(page.getByRole('button', { name: 'Pick A' })).toBeEnabled({ timeout: 60_000 });
}

test('a stack of identical frames is set up to be triaged', async ({ page }) => {
  await addLibrary(page, TRIAGE_DIR, { autoStack: true, photos: TRIAGE_PHOTO_NAMES.length });
  await openLibrary(page, TRIAGE_DIR);
  await expect(stackFrames(page)).toHaveAccessibleName(new RegExp(`stack of ${TRIAGE_PHOTO_NAMES.length}, `), { timeout: 45_000 });
});

test('the viewer offers the way in for any member of a stack, not just its representative', async ({ page }) => {
  // Every member, including the ones a collapsed listing gives no row of their
  // own: `stack_size` is 1 on all of them, so gating the button on it would hide
  // it everywhere it is actually reachable from.
  //
  // The band is client state and does not survive the trip back, so it is opened
  // once per member rather than once for the loop.
  for (let index = 0; index < TRIAGE_PHOTO_NAMES.length; index++) {
    await page.goto(route(PathSegment.settings()));
    await openLibrary(page, TRIAGE_DIR);
    await expect(stackFrames(page)).toBeVisible({ timeout: 45_000 });
    await stackFrames(page).click();
    await expect(bands(page).getByRole('listitem')).toHaveCount(TRIAGE_PHOTO_NAMES.length);

    await frames(bands(page)).nth(index).click();
    await expect(page.getByRole('button', { name: 'Triage stack' })).toBeVisible();
  }
});

// Split can lay the pair out top and bottom, where `←` and `→` point at nothing,
// so both arrows of both axes cast the same two verdicts. That costs `↓` its Pick both,
// which keeps Space.
test('either arrow of either axis casts, and Pick both is Space alone', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await enterTriage(page);

  const pool = TRIAGE_PHOTO_NAMES.length;
  // A draw: the pool holds, and the round it judged leaves the projection - every
  // pair of the pool bar the one just seen.
  const afterDraw = (pool * (pool - 1)) / 2 - 1;
  await page.keyboard.press('Space');
  await expect(queueButton(page)).toContainText(`(${pool})`);

  // The projection is inside the queue, which is the only place it is spelled out.
  const queue = page.getByRole('button', { name: 'Queue' });
  await queue.click();
  const count = page.getByText(/left \(out of/);
  await expect(count).toContainText(`${pool} left (out of ${pool}) · up to ${afterDraw} rounds`);
  await queue.click();
  await expect(count).toHaveCount(0);

  // Up is the first photograph, as Left is. Behind the same gate the buttons
  // carry: the keys are dead until both frames of *this* round are up, and a
  // press into that window is dropped rather than queued.
  await expect(page.getByRole('button', { name: 'Pick A' })).toBeEnabled({ timeout: 60_000 });
  await page.keyboard.press('ArrowUp');
  await expect(queueButton(page)).toContainText(`(${pool - 1})`);
  await expect.poll(() => countOf(page, stackIdOf(page), 'rejected'), { timeout: 20_000 }).toBe(1);
});

test('a decisive verdict holds the winner over, and re-judging it from the queue discards what came after', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await enterTriage(page);

  const pool = TRIAGE_PHOTO_NAMES.length;
  await expect(queueButton(page)).toContainText(`(${pool})`);
  await page.getByRole('button', { name: 'Pick A' }).click();
  await expect(queueButton(page)).toContainText(`(${pool - 1})`);
  // Still a round to judge, rather than a session that has ended.
  await expect(page.getByRole('button', { name: 'Pick A' })).toBeVisible();
  // And the loser is rejected in the catalogue, not merely gone from the count. The write
  // has to have landed, or the Queue row below is clicked while the session is still busy
  // and the rewind is silently dropped.
  await expect.poll(() => countOf(page, stackIdOf(page), 'rejected'), { timeout: 20_000 }).toBe(1);

  await page.getByRole('button', { name: 'Queue' }).click();
  // Completed rows are the clickable ones; Upcoming is deliberately inert, because a
  // round that has not been judged is not somewhere to jump to.
  const completed = page.getByRole('dialog').getByRole('button');
  await expect(completed.first()).toContainText('Pick A');
  await completed.first().click();

  // Back to the opening round, with the photo that verdict rejected returned to
  // the pool and its rejection taken back.
  await expect(queueButton(page)).toContainText(`(${pool})`);
  await expect.poll(() => countOf(page, stackIdOf(page), 'rejected'), { timeout: 20_000 }).toBe(0);
  // Asserted with the popover still open, or an unmounted list would satisfy this
  // however the rewind went.
  await expect(page.getByText('No verdicts yet')).toBeVisible();
  await expect(completed).toHaveCount(0);
});

// Flipped in three kinds of round: the first; one whose *both* frames are new to the
// stage; and one holding a winner carried over from the round before.
test('flip shows one frame at a time and keeps both reachable, round after round, and split draws both', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await enterTriage(page);

  // Both frames of the round are mounted under one photoKey: that is what makes
  // the flip free, and what the verdict bar waits for.
  const mounted = photoStage(page).locator('canvas[role="img"]');
  await expect(mounted).toHaveCount(2);
  await expect(shownFrame(page)).toHaveCount(1);
  const first = await shown(page);
  await page.getByRole('button', { name: 'Show B' }).click();
  await expect.poll(() => shown(page), { timeout: 10_000 }).not.toBe(first);
  await expect(shownFrame(page)).toHaveCount(1);
  // Still two mounted: the one flipped away from keeps its raster rather than
  // being unmounted and decoded again on the way back.
  await expect(mounted).toHaveCount(2);
  await page.getByRole('button', { name: 'Show A' }).click();
  await expect.poll(() => shown(page), { timeout: 10_000 }).toBe(first);

  const flipsBothWays = async (): Promise<void> => {
    const onA = await shown(page);
    await page.getByRole('button', { name: 'Show B' }).click();
    await expect.poll(() => shown(page), { timeout: 10_000 }).not.toBe(onA);
    await page.getByRole('button', { name: 'Show A' }).click();
    await expect.poll(() => shown(page), { timeout: 10_000 }).toBe(onA);
  };

  // A round whose both frames are new to the stage, both already fetched, so both
  // decode in one batch. Only a draw produces one - a decisive verdict always
  // carries its winner over - and only with four members, since with three the round
  // after a draw still holds a frame the stage had. A promotion that reads its
  // previous state from anything but the updater loses one of the two here, and the
  // slot it lost is unreachable for the rest of the round with nothing in any count
  // to say so.
  await page.getByRole('button', { name: 'Pick both' }).click();
  await expect(queueButton(page)).toContainText(`(${TRIAGE_PHOTO_NAMES.length})`);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  // The drawn pair went to the back, so neither frame of this round has been on
  // the stage before.
  await expect.poll(() => shown(page), { timeout: 10_000 }).not.toBe(first);
  await flipsBothWays();

  // A decisive verdict holds the winner over, so the next round mounts one source
  // the stage already had and one it did not. The frame that carried over must
  // still be reachable: it is half of every round after the first.
  await expect(page.getByRole('button', { name: 'Pick A' })).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Pick A' }).click();
  await expect(queueButton(page)).toContainText(`(${TRIAGE_PHOTO_NAMES.length - 1})`);
  await expect(shownFrame(page)).toBeVisible({ timeout: 60_000 });
  await flipsBothWays();

  await page.getByRole('button', { name: 'Split' }).click();
  await expect(photoStage(page)).toHaveCount(2);

  const boxes = await photoStage(page).evaluateAll((halves) =>
    halves.map((half) => {
      const box = half.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }),
  );
  // The fixture is one RAW copied under three names, so both frames share an
  // aspect and equal area means equal boxes.
  expect(boxes).toHaveLength(2);
  expect(Math.abs(boxes[0]!.width * boxes[0]!.height - boxes[1]!.width * boxes[1]!.height)).toBeLessThan(4);

  await page.getByRole('button', { name: 'Flip' }).click();
  await expect(page.getByRole('group', { name: 'Which photo to show' })).toBeVisible();
});

// The session ends on the survivor rather than on a screen about the session,
// and the culling pass carries on from there. Not on the photo it was entered
// from: a decisive session usually rejects it, and a rejected photo has left the
// gallery's filter, so the viewer could say nothing about what came before or
// after it and both arrows were dead.
test('a session runs to its end, writes its verdicts, and ends on a live photo in the collection it was entered from', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await enterTriage(page);
  const entry = page.url();
  // Off the route while the session is still on it: the screen leaves for the
  // viewer as it ends, and the stack is not in the address it lands at.
  const stackId = stackIdOf(page);

  // The winner is held over and meets each of the others in turn, so a run of
  // decisive verdicts settles the stack in N-1 rounds. Always B, so the frame the
  // session was entered from is rejected.
  const pool = TRIAGE_PHOTO_NAMES.length;
  for (let left = pool; left > 1; left--) {
    await expect(queueButton(page)).toContainText(`(${left})`);
    await page.getByRole('button', { name: /^Pick B / }).click();
  }
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.photos())}/`), { timeout: 30_000 });

  // The verdicts are the photographs' own now, not just the screen's. Polled on
  // the `picked` write, which is the *last* one a session makes: the rejections
  // land first, so waiting on those and then reading the keeper catches the
  // closing write still in flight.
  await expect.poll(() => countOf(page, stackId, 'picked'), { timeout: 20_000 }).toBe(1);
  expect(await countOf(page, stackId, 'rejected')).toBe(pool - 1);
  expect(page.url()).not.toBe(entry);

  const landed = openPhotoId(page);
  const members = (await (await page.request.get(stackPhotosUrl(stackId))).json()) as {
    id: string;
    triage: string;
  }[];
  expect(members.find((member) => member.id === landed)?.triage).toBe('picked');

  // And it is a row the collapsed collection actually holds, which is what lets
  // the viewer place it and say what comes before and after. Asserted against the
  // listing rather than the Next button, because this fixture library is nothing
  // but the stack: collapsed, it is one row, so there is genuinely nothing after
  // it to step to.
  const libraries = (await (
    await page.request.get(`${API_URL}${route(PathSegment.api(), PathSegment.libraries())}`)
  ).json()) as { id: string; root_path: string }[];
  const library = libraries.find((entry) => entry.root_path === TRIAGE_DIR);
  if (library == null) throw new Error('the triage library is not listed');
  const listing = (await (
    await page.request.get(
      `${API_URL}${route(PathSegment.api(), PathSegment.libraries(), library.id, PathSegment.photos())}?limit=50`,
    )
  ).json()) as { photos: { id: string }[] };
  expect(listing.photos.map((photo) => photo.id)).toContain(landed);
});

test('Pick remaining photos ends the session with everything still in the pool', async ({ page }) => {
  await page.goto(route(PathSegment.settings()));
  await enterTriage(page);
  const stackId = stackIdOf(page);

  // Pressed before anything has been judged, so every member survives and none of
  // them has been compared with anything.
  await page.getByRole('button', { name: 'Pick remaining photos' }).click();
  await expect(page).toHaveURL(new RegExp(`${route(PathSegment.photos())}/`), { timeout: 30_000 });

  // Nothing was compared, so nothing is claimed: a survivor that never reached
  // the screen is left exactly as it was rather than quietly written picked,
  // which is the distinction the closing rule exists to keep.
  expect(await countOf(page, stackId, 'picked')).toBe(0);
  expect(await countOf(page, stackId, 'rejected')).toBe(0);
});
