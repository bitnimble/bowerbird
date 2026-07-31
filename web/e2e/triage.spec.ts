import { expect, test, type Page } from '@playwright/test';
import { API_URL, TRIAGE_PHOTO_NAMES, TRIAGE_PHOTOS_DIR } from './fixture_library';
import { addLibrary, openLibrary, syncLibrary, waitForSyncSettled } from './helpers';

// Stack triage, driven through the real screen (DESIGN §20).
//
// Its own library, because the tournament writes triage over every member and the
// stacks spec counts on theirs being untouched. Three frames rather than two: two
// is a single round, which cannot show a winner being held over, a second entry
// in the queue, or a rewind to anything but the start.
//
// Serial, because each test leaves the catalogue where the next one starts.
test.describe.configure({ mode: 'serial' });

const TRIAGE_DIR = TRIAGE_PHOTOS_DIR;

// The verdicts as the catalogue holds them, which is what a session is for. Read
// through the API rather than off the screen: the point is that the photographs
// carry them once the session is over, not that the summary said so.
//
// The stack's own members, not the library listing, which collapses a stack to
// one row (§19.5.1) and would report a single verdict for all three.
async function countOf(page: Page, stackId: string, triage: string): Promise<number> {
  const response = await page.request.get(`${API_URL}/api/stacks/${stackId}/photos`);
  if (!response.ok()) return -1;
  const members = (await response.json()) as { triage: string }[];
  return members.filter((member) => member.triage === triage).length;
}

// The session's own stack, taken from the route it is running on.
function stackIdOf(page: Page): string {
  return /\/stacks\/([^/]+)\/triage/.exec(page.url())?.[1] ?? '';
}

// Puts every member back to untriaged.
//
// A session captures each member's verdict as the baseline every undo restores
// to, so a test inheriting the previous one's rejections inherits them as the
// *correct* answer and its absolute counts stop meaning anything. Cheaper than
// giving each test its own library, and it keeps them independent of each other's
// verdict order.
async function clearVerdicts(page: Page): Promise<void> {
  const libraries = await page.request.get(`${API_URL}/api/libraries`);
  const list = (await libraries.json()) as { id: string; root_path: string }[];
  const library = list.find((entry) => entry.root_path === TRIAGE_DIR);
  if (library == null) return;
  const rows = await page.request.get(`${API_URL}/api/libraries/${library.id}/photos?limit=200&include_deleted=true`);
  const { photos } = (await rows.json()) as { photos: { id: string; stack_id: string | null }[] };
  const stackId = photos.find((photo) => photo.stack_id != null)?.stack_id;
  if (stackId == null) return;
  const members = (await (await page.request.get(`${API_URL}/api/stacks/${stackId}/photos`)).json()) as { id: string }[];
  for (const member of members) {
    await page.request.patch(`${API_URL}/api/photos/${member.id}`, { data: { triage: 'untriaged' } });
  }
}

// Opens a member of the stack in the viewer, which is the only way in (§20.5).
async function enterTriage(page: Page): Promise<void> {
  await clearVerdicts(page);
  await openLibrary(page, TRIAGE_DIR);
  await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });
  // A stack's tile opens its band rather than the photo, so the way to a member's
  // detail view is through the band.
  await page.locator('.tile:not(.tile--member) .tile__hit').click();
  await expect(page.locator('.grid__band .tile')).toHaveCount(TRIAGE_PHOTO_NAMES.length);
  await page.locator('.grid__band .tile__hit').first().dblclick();

  await page.getByRole('link', { name: 'Triage stack' }).click();
  await expect(page.locator('.triage-page')).toBeVisible();
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
}

test('a stack of identical frames is set up to be triaged', async ({ page }) => {
  await addLibrary(page, TRIAGE_DIR, { autoStack: true });
  await syncLibrary(page, TRIAGE_DIR);
  await waitForSyncSettled(page, TRIAGE_DIR, TRIAGE_PHOTO_NAMES.length);
  await openLibrary(page, TRIAGE_DIR);
  await expect(page.locator('.tile__stack-count')).toHaveText(String(TRIAGE_PHOTO_NAMES.length), { timeout: 45_000 });
});

test('the viewer offers the way in for any member of a stack, not just its representative', async ({ page }) => {
  // Every member, including the ones a collapsed listing gives no row of their
  // own: `stack_size` is 1 on all of them, so gating the button on it would hide
  // it everywhere it is actually reachable from.
  //
  // The band is client state and does not survive the trip back, so it is opened
  // once per member rather than once for the loop.
  for (let index = 0; index < TRIAGE_PHOTO_NAMES.length; index++) {
    await page.goto('/settings');
    await openLibrary(page, TRIAGE_DIR);
    await expect(page.locator('.tile__stack')).toBeVisible({ timeout: 45_000 });
    await page.locator('.tile:not(.tile--member) .tile__hit').click();
    await expect(page.locator('.grid__band .tile')).toHaveCount(TRIAGE_PHOTO_NAMES.length);

    await page.locator('.grid__band .tile__hit').nth(index).dblclick();
    await expect(page.getByRole('link', { name: 'Triage stack' })).toBeVisible();
  }
});

test('a decisive verdict rejects the loser and holds the winner over', async ({ page }) => {
  await page.goto('/settings');
  await enterTriage(page);

  const pool = TRIAGE_PHOTO_NAMES.length;
  await expect(page.locator('.triage__verdicts')).toContainText(`${pool} left`);
  await page.getByRole('button', { name: 'A better' }).click();

  await expect(page.locator('.triage__verdicts')).toContainText(`${pool - 1} left`);
  // Still a round to judge, rather than a summary.
  await expect(page.getByRole('button', { name: 'A better' })).toBeVisible();
  // And the loser is rejected in the catalogue, not merely gone from the count.
  await expect.poll(() => countOf(page, stackIdOf(page), 'rejected'), { timeout: 20_000 }).toBe(1);
});

test('the queue reaches a completed round, and re-judging it discards what came after', async ({ page }) => {
  await page.goto('/settings');
  await enterTriage(page);

  const pool = TRIAGE_PHOTO_NAMES.length;
  await page.getByRole('button', { name: 'A better' }).click();
  await expect(page.locator('.triage__verdicts')).toContainText(`${pool - 1} left`);
  // The write has to have landed, or the Queue row below is clicked while the
  // session is still busy and the rewind is silently dropped.
  await expect.poll(() => countOf(page, stackIdOf(page), 'rejected'), { timeout: 20_000 }).toBe(1);

  await page.getByRole('button', { name: 'Queue' }).click();
  // Completed rows are the clickable ones; Upcoming shares the class and is
  // deliberately inert, because a round that has not been judged is not somewhere
  // to jump to.
  const completed = page.locator('button.triage__queue-row');
  await expect(completed.first()).toContainText('A better');
  await completed.first().click();

  // Back to the opening round, with the photo that verdict rejected returned to
  // the pool and its rejection taken back.
  await expect(page.locator('.triage__verdicts')).toContainText(`${pool} left`);
  await expect.poll(() => countOf(page, stackIdOf(page), 'rejected'), { timeout: 20_000 }).toBe(0);
  // Asserted with the popover still open, or an unmounted list would satisfy this
  // however the rewind went.
  await expect(page.getByText('Nothing judged yet')).toBeVisible();
  await expect(completed).toHaveCount(0);
});

test('flip shows one frame at a time and keeps both decoded', async ({ page }) => {
  await page.goto('/settings');
  await enterTriage(page);

  // Both frames of the round are mounted under one photoKey: that is what makes
  // the flip free, and what the verdict bar waits for.
  await expect(page.locator('.stage__viewport img')).toHaveCount(2);
  await expect(page.locator('.stage__viewport img.is-ready')).toHaveCount(1);

  await page.getByRole('button', { name: 'B', exact: true }).click();
  await expect(page.locator('.stage__viewport img.is-ready')).toHaveCount(1);
  // Still two mounted: the one flipped away from keeps its raster rather than
  // being unmounted and decoded again on the way back.
  await expect(page.locator('.stage__viewport img')).toHaveCount(2);
});

// A decisive verdict holds the winner over, so the next round mounts one source
// the stage already had and one it did not. The frame that carried over must
// still be reachable: it is half of every round after the first.
test('flip still shows both frames in a round after the first', async ({ page }) => {
  await page.goto('/settings');
  await enterTriage(page);

  await page.getByRole('button', { name: 'A better' }).click();
  await expect(page.locator('.triage__verdicts')).toContainText(`${TRIAGE_PHOTO_NAMES.length - 1} left`);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });

  const shown = (): Promise<string> => page.locator('.stage__viewport img.is-ready').evaluate((img) => (img as HTMLImageElement).src);
  const onA = await shown();

  await page.getByRole('button', { name: 'B', exact: true }).click();
  await expect.poll(shown, { timeout: 10_000 }).not.toBe(onA);

  await page.getByRole('button', { name: 'A', exact: true }).click();
  await expect.poll(shown, { timeout: 10_000 }).toBe(onA);
});

// A round whose *both* frames are new to the stage, both already fetched, so both
// decode in one batch. Only a draw produces one - a decisive verdict always
// carries its winner over - and only with four members, since with three the round
// after a draw still holds a frame the stage had. A promotion that reads its
// previous state from anything but the updater loses one of the two here, and the
// slot it lost is unreachable for the rest of the round with nothing in any count
// to say so.
test('both slots stay reachable when a round arrives with two new frames', async ({ page }) => {
  await page.goto('/settings');
  await enterTriage(page);

  const shown = (): Promise<string> => page.locator('.stage__viewport img.is-ready').evaluate((img) => (img as HTMLImageElement).src);
  const before = await shown();

  await page.getByRole('button', { name: 'Both' }).click();
  await expect(page.locator('.triage__verdicts')).toContainText(`${TRIAGE_PHOTO_NAMES.length} left`);
  await expect(page.locator('.stage__viewport img.is-ready')).toBeVisible({ timeout: 60_000 });
  // The drawn pair went to the back, so neither frame of this round has been on
  // the stage before.
  await expect.poll(shown, { timeout: 10_000 }).not.toBe(before);

  const onA = await shown();
  await page.getByRole('button', { name: 'B', exact: true }).click();
  await expect.poll(shown, { timeout: 10_000 }).not.toBe(onA);
  await page.getByRole('button', { name: 'A', exact: true }).click();
  await expect.poll(shown, { timeout: 10_000 }).toBe(onA);
});

test('split draws both photos at once, at the same area', async ({ page }) => {
  await page.goto('/settings');
  await enterTriage(page);

  await page.getByRole('button', { name: 'Split' }).click();
  await expect(page.locator('.triage__half')).toHaveCount(2);

  const boxes = await page.locator('.triage__half').evaluateAll((halves) =>
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
  await expect(page.locator('.triage__flip')).toBeVisible();
});

test('a session runs to a summary, and writes the verdicts it made', async ({ page }) => {
  await page.goto('/settings');
  await enterTriage(page);

  // The winner is held over and meets each of the others in turn, so a run of
  // decisive verdicts settles the stack in N-1 rounds.
  const pool = TRIAGE_PHOTO_NAMES.length;
  for (let left = pool; left > 1; left--) {
    await expect(page.locator('.triage__verdicts')).toContainText(`${left} left`);
    await page.getByRole('button', { name: 'A better' }).click();
  }

  await expect(page.locator('.triage__summary')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.triage__summary')).toContainText('Kept · 1');
  await expect(page.locator('.triage__summary')).toContainText(`Rejected · ${pool - 1}`);

  // The verdicts are the photographs' own now, not just the screen's. Polled on
  // the `picked` write, which is the *last* one a session makes: the rejections
  // land first, so waiting on those and then reading the keeper catches the
  // closing write still in flight.
  const stackId = stackIdOf(page);
  await expect.poll(() => countOf(page, stackId, 'picked'), { timeout: 20_000 }).toBe(1);
  expect(await countOf(page, stackId, 'rejected')).toBe(pool - 1);

  // And undo from the summary takes the closing writes back and re-opens the
  // round that ended it, rather than landing on the summary it was pressed from.
  // In this test rather than the next one: a session is a page's worth of state,
  // and Playwright hands every test its own.
  await page.getByRole('button', { name: 'Undo the last round' }).click();
  await expect(page.locator('.triage__verdicts')).toBeVisible();
  await expect(page.locator('.triage__summary')).toHaveCount(0);
  await expect.poll(() => countOf(page, stackId, 'picked'), { timeout: 20_000 }).toBe(0);
  // The verdict being re-offered is the one that ended the session, so the losers
  // of the rounds before it are still rejected: undo takes back a round, not the
  // whole tournament.
  expect(await countOf(page, stackId, 'rejected')).toBe(pool - 2);
});

test('Keep the rest ends the session with everything still in the pool', async ({ page }) => {
  await page.goto('/settings');
  await enterTriage(page);

  // Pressed before anything has been judged, so every member survives and none of
  // them has been compared with anything.
  await page.getByRole('button', { name: 'Keep the rest' }).click();
  await expect(page.locator('.triage__summary')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.triage__summary')).toContainText(`Kept · ${TRIAGE_PHOTO_NAMES.length}`);

  // Nothing was compared, so nothing is claimed: the keepers are marked rather
  // than quietly written picked, which is the distinction the closing rule exists
  // to keep.
  await expect(page.locator('.triage__thumb-note').first()).toContainText('not compared');
  expect(await countOf(page, stackIdOf(page), 'picked')).toBe(0);
});
