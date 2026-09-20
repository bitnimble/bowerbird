import { afterEach, beforeEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';
import { MemoryStorage } from '../../../../test_storage';

registerDom();
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react');
const React = await import('react');
const { MemoryRouter, Route, Routes } = await import('react-router-dom');
const { StoresProvider } = await import('../../../../app/stores_context');
const { compositesApi } = await import('../../../../api/composites');
const { MergePage } = await import('../merge_page');
const { MergePageStrings } = await import('../merge_page.strings');
const { PhotoStageStrings } = await import('../../viewer/photo_stage.strings');
const { mergeJobPath } = await import('../../photos_store');
const { readyJobFixture, saveSeededSession, triangleSeams } = await import('./fixtures/assembly_recipe');

const stubbed = {
  getAssemblyJob: compositesApi.getAssemblyJob,
  startAssembly: compositesApi.startAssembly,
  cancelAssembly: compositesApi.cancelAssembly,
  solveSeams: compositesApi.solveSeams,
};
// The page saves its session on every pick, and a DOM installs no storage: run alone, without this,
// every test here throws.
beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
});

afterEach(() => {
  cleanup();
  Object.assign(compositesApi, stubbed);
});

function ready(): void {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  saveSeededSession('job1');
}

function analysing(): void {
  compositesApi.getAssemblyJob = (id) =>
    Promise.resolve({ id, photoIds: ['f1', 'f2'], status: 'analysing', fraction: 0.3 });
}

// The page builds its own store and presenter, so what the app-level contexts are here for is the
// toasts the presenter reports a failed save through.
function renderJob(): void {
  render(
    React.createElement(
      StoresProvider,
      null,
      React.createElement(
        MemoryRouter,
        { initialEntries: [mergeJobPath('job1', null)] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: mergeJobPath(':jobId', null), element: React.createElement(MergePage) }),
        ),
      ),
    ),
  );
}

/** The carve having landed, which is the bar appearing. */
function settled(): Promise<HTMLElement> {
  return screen.findByRole('button', { name: /^save$/i });
}

function viewport(): HTMLElement {
  return screen.getByRole('region', { name: PhotoStageStrings.stage() });
}

function pieces(): HTMLElement[] {
  return screen.queryAllByRole('button', { name: /^Tile \d+$/ });
}

function outlines(): NodeListOf<SVGPathElement> {
  return viewport().querySelectorAll('canvas + svg path');
}

test('an analysis in flight shows its progress and offers Cancel', async () => {
  analysing();
  renderJob();
  expect(await screen.findByText(/analysing photos… 30%/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: /cancel/i })).toBeTruthy();
});

// Opening the page is reading a job the menu already started; nothing about a mount starts work.
test('the page never starts a carve of its own', async () => {
  let started = 0;
  compositesApi.startAssembly = () => {
    started++;
    return Promise.resolve({ jobId: 'job1' });
  };
  ready();
  renderJob();
  await settled();
  expect(started).toBe(0);
});

test('Cancel stops the carve and leaves the page saying so rather than waiting forever', async () => {
  const stopped: string[] = [];
  compositesApi.cancelAssembly = (id) => {
    stopped.push(id);
    return Promise.resolve();
  };
  analysing();
  renderJob();
  fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
  expect(await screen.findByText(/couldn't analyse/i)).toBeTruthy();
  expect(stopped).toEqual(['job1']);
});

test('an analysis with no tiles shows a stage that takes a click', async () => {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  renderJob();
  await settled();
  const remove = screen.getByRole('button', { name: MergePageStrings.removeObjects() }) as HTMLButtonElement;
  expect(remove.disabled).toBe(false);
  expect(outlines()).toHaveLength(0);
});

test('Remove objects is a mode the bar holds pressed until it is pressed again', async () => {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  renderJob();
  await settled();
  const remove = screen.getByRole('button', { name: MergePageStrings.removeObjects() });
  expect(remove.getAttribute('aria-pressed')).toBe('false');

  fireEvent.click(remove);
  expect(remove.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(remove);
  expect(remove.getAttribute('aria-pressed')).toBe('false');
});

test('frames the analysis found unaligned are flagged in the bar, and aligned ones are not', async () => {
  const job = readyJobFixture();
  compositesApi.getAssemblyJob = () => Promise.resolve(job);
  renderJob();
  await settled();
  expect(screen.queryByRole('img', { name: MergePageStrings.unaligned() })).toBeNull();
  cleanup();

  compositesApi.getAssemblyJob = () =>
    Promise.resolve({ ...job, carved: { ...job.carved!, analysed: { ...job.carved!.analysed, unaligned: true } } });
  renderJob();
  await settled();
  expect(screen.getByRole('img', { name: MergePageStrings.unaligned() }).getAttribute('title')).toBe(
    MergePageStrings.unaligned(),
  );
});

test('a recipe with nothing to solve against outlines its tiles', async () => {
  ready();
  renderJob();
  await settled();
  expect(pieces()).toHaveLength(2);
});

test('a pick draws only the piece solved for it, and that piece opens its tile', async () => {
  const job = readyJobFixture();
  job.carved!.analysed.recipe = { ...job.carved!.analysed.recipe, seamVolume: 'key' };
  compositesApi.getAssemblyJob = () => Promise.resolve(job);
  saveSeededSession('job1');
  const held: (() => void)[] = [];
  compositesApi.solveSeams = (recipe, picks) =>
    new Promise<void>((resolve) => held.push(resolve)).then(() => ({
      seams: picks.map((pick) =>
        triangleSeams(
          pick,
          pick.findIndex((source) => source !== recipe.base),
          300,
        ),
      ),
    }));
  renderJob();
  await settled();
  expect(outlines()).toHaveLength(0);

  fireEvent.keyDown(window, { key: ']' });
  // Until every frame's growth of the tile is solved, a swatch would only show the tile as drawn.
  expect(screen.getByRole('status', { name: /finding the best parts of each frame/i })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /choose frame/i })).toBeNull();
  fireEvent.keyDown(window, { key: '2' });
  expect(screen.getByRole('dialog')).toBeTruthy();

  const swatch = (): HTMLElement | null => screen.queryByRole('button', { name: 'Choose frame 2' });
  while (swatch() == null) {
    await waitFor(() => expect(held.length > 0 || swatch() != null).toBe(true));
    held.shift()?.();
  }
  expect(screen.queryByRole('status', { name: /finding the best parts of each frame/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Choose frame 2' }));

  await waitFor(() => expect(pieces()).toHaveLength(1));
  expect(outlines()).toHaveLength(1);
  const piece = pieces()[0]!;
  expect(piece.getAttribute('d')).toBe('M0,0L300,0L0,300Z');
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(piece);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('clicking a piece opens its swatches', async () => {
  ready();
  renderJob();
  await settled();
  fireEvent.click(pieces()[0]!);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

// The viewport is what hears the pointer, not the overlay: a drag takes the pointer capture, and
// from there every pointer event is retargeted to the capturing element.
function dragTo(to: [number, number]): void {
  const stage = viewport();
  fireEvent.pointerDown(stage, { pointerId: 1, isPrimary: true, clientX: 20, clientY: 4 });
  fireEvent.pointerMove(stage, { pointerId: 1, isPrimary: true, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(stage, { pointerId: 1, isPrimary: true, clientX: to[0], clientY: to[1] });
}

test('a press that travelled is a pan, and its click opens nothing', async () => {
  ready();
  renderJob();
  await settled();
  dragTo([120, 16]);
  fireEvent.click(pieces()[0]!);
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('and a press that barely moves is the click that opens a tile', async () => {
  ready();
  renderJob();
  await settled();
  dragTo([22, 4]);
  fireEvent.click(pieces()[0]!);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

// Where a click lands needs a decoded layer, which jsdom has none of: that it seeds a tile is
// `take_best_parts.spec.ts`, and the seed itself the presenter's tests.
test('a press that closes a popup is not also a click on the picture', async () => {
  ready();
  renderJob();
  await settled();
  fireEvent.keyDown(window, { key: ']' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.pointerDown(viewport(), { pointerId: 1, isPrimary: true, clientX: 20, clientY: 4 });
  fireEvent.pointerUp(viewport(), { pointerId: 1, isPrimary: true, clientX: 20, clientY: 4 });
  fireEvent.click(viewport());
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a press on a piece that closes a popup does not open that piece', async () => {
  ready();
  renderJob();
  await settled();
  fireEvent.keyDown(window, { key: ']' });
  expect(screen.getByRole('dialog')).toBeTruthy();
  const piece = pieces()[1]!;
  fireEvent.pointerDown(piece, { pointerId: 1, isPrimary: true, clientX: 20, clientY: 4 });
  fireEvent.pointerUp(piece, { pointerId: 1, isPrimary: true, clientX: 20, clientY: 4 });
  fireEvent.click(piece);
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.pointerDown(piece, { pointerId: 1, isPrimary: true, clientX: 20, clientY: 4 });
  fireEvent.pointerUp(piece, { pointerId: 1, isPrimary: true, clientX: 20, clientY: 4 });
  fireEvent.click(piece);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

// A toggle reads as one: pressed while it is on, and off it still hit-tests.
test('the tile lines are a toggle, and hidden lines still open their tile', async () => {
  ready();
  renderJob();
  await settled();
  const lines = screen.getByRole('button', { name: /show or hide tile lines/i });
  expect(lines.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(lines);
  expect(lines.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(pieces()[0]!);
  expect(screen.getByRole('dialog')).toBeTruthy();
});

test('there is no drawing tool', async () => {
  ready();
  renderJob();
  await settled();
  expect(screen.queryByRole('button', { name: /draw tiles/i })).toBeNull();
});

// §2.8's `[` and `]`, which is how a reader walks every tile without hunting for the outlines.
test('the bracket keys step between tiles', async () => {
  ready();
  renderJob();
  await settled();
  fireEvent.keyDown(window, { key: ']' });
  expect(screen.getByRole('dialog')).toBeTruthy();
});

// §2.2's zoom: one transform over the canvas and the overlay together, because an outline that
// stayed put while the picture moved under it would point at the wrong pixels at every scale.
test('the picture and its outlines ride one transform', async () => {
  ready();
  renderJob();
  await settled();
  const view = viewport().querySelector('canvas')!.parentElement!;
  expect(view.style.transform).toContain('scale(');
  expect(pieces()[0]!.closest('svg')?.parentElement).toBe(view);
});

// The editor's history, on the editor's controls: nothing but a pick moves, so both are dead until
// one is made.
test('undo and redo follow the picks, and start with nothing to take back', async () => {
  ready();
  renderJob();
  await settled();
  const undo = screen.getByRole('button', { name: MergePageStrings.undo() }) as HTMLButtonElement;
  const redo = screen.getByRole('button', { name: MergePageStrings.redo() }) as HTMLButtonElement;
  expect(undo.disabled).toBe(true);
  expect(redo.disabled).toBe(true);

  fireEvent.click(pieces()[0]!);
  fireEvent.click(screen.getAllByRole('button', { name: /choose frame/i })[1]!);
  expect(undo.disabled).toBe(false);

  fireEvent.click(undo);
  expect(redo.disabled).toBe(false);
});
