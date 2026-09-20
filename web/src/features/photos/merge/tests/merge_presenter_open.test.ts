import { afterEach, beforeEach, expect, test } from 'bun:test';
import { MOST_FEATHER } from '../../../../../../src/schemas/assembly';
import { type AssemblyJob, type ReopenedAssembly } from '../../../../../../src/schemas/assembly';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { compositesApi } from '../../../../api/composites';
import { MemoryStorage } from '../../../../test_storage';
import { ToastsPresenter } from '../../../toasts/toasts_presenter';
import { ToastsStore } from '../../../toasts/toasts_store';
import { JOB_POLL_MS, MergePresenter } from '../merge_presenter';
import { loadMergeSession, saveMergeSession } from '../merge_storage';
import { MergeStore } from '../merge_store';
import {
  assemblyRecipeFixture,
  FIXTURE_SEEDS,
  NO_COMPOSITOR,
  readyJobFixture,
  saveSeededSession,
} from './fixtures/assembly_recipe';

const jobId = 'job1';

function analysing(fraction: number): AssemblyJob {
  return { id: jobId, photoIds: ['f1', 'f2'], status: 'analysing', fraction };
}

function finished(): ReopenedAssembly {
  return { recipe: assemblyRecipeFixture(), layers: [], missingSources: [] };
}

const stubbed = {
  getAssemblyJob: compositesApi.getAssemblyJob,
  startAssembly: compositesApi.startAssembly,
  cancelAssembly: compositesApi.cancelAssembly,
  getAssembly: compositesApi.getAssembly,
  listPhotoFrames: compositesApi.listFrames,
};

beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
});
afterEach(() => {
  compositesApi.getAssemblyJob = stubbed.getAssemblyJob;
  compositesApi.startAssembly = stubbed.startAssembly;
  compositesApi.cancelAssembly = stubbed.cancelAssembly;
  compositesApi.getAssembly = stubbed.getAssembly;
  compositesApi.listFrames = stubbed.listPhotoFrames;
});

function build(): { store: MergeStore; presenter: MergePresenter } {
  const store = new MergeStore();
  const presenter = new MergePresenter(store, new ToastsPresenter(new ToastsStore()), NO_COMPOSITOR);
  return { store, presenter };
}

const polled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS + 20));

test('opening a finished job lands ready', async () => {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  saveSeededSession(jobId);
  const { store, presenter } = build();
  await presenter.openJob(jobId);
  expect(store.status).toBe('ready');
  expect(store.recipe?.tiles).toHaveLength(2);
  expect(store.picks).toEqual([0, 0]);
});

// The page is keyed by a job the menu already started, so opening it only ever reads.
test('opening a job never starts a carve', async () => {
  let started = 0;
  compositesApi.startAssembly = () => {
    started++;
    return Promise.resolve({ jobId });
  };
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  const { presenter } = build();
  await presenter.openJob(jobId);
  expect(started).toBe(0);
});

test('the bar follows the job while it carves, then the tiles land', async () => {
  const answers = [analysing(0.2), analysing(0.6), readyJobFixture()];
  compositesApi.getAssemblyJob = () => Promise.resolve(answers.shift()!);
  const { store, presenter } = build();
  const opening = presenter.openJob(jobId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.status).toBe('analysing');
  expect(store.progress).toBe(0.2);
  await polled();
  expect(store.progress).toBe(0.6);
  await opening;
  expect(store.status).toBe('ready');
});

// §3.9: the carve is minutes of the device, and only the call tells it to let go.
test('cancel stops watching and tells the server to stop analysing', async () => {
  const stopped: string[] = [];
  compositesApi.cancelAssembly = (id) => {
    stopped.push(id);
    return Promise.resolve();
  };
  compositesApi.getAssemblyJob = () => Promise.resolve(analysing(0.1));
  const { store, presenter } = build();
  const opening = presenter.openJob(jobId);
  await polled();
  presenter.cancel();
  await opening;
  expect(stopped).toEqual([jobId]);
  expect(store.status).toBe('error');
});

// The job is the server's, not the page's: leaving stops the watching and nothing else.
test('leaving a page posts no cancel, even mid-carve', async () => {
  const stopped: string[] = [];
  compositesApi.cancelAssembly = (id) => {
    stopped.push(id);
    return Promise.resolve();
  };
  compositesApi.getAssemblyJob = () => Promise.resolve(analysing(0.1));
  const { presenter } = build();
  const opening = presenter.openJob(jobId);
  await polled();
  presenter.finish();
  await opening;
  expect(stopped).toEqual([]);
});

test('a failed carve names why', async () => {
  compositesApi.getAssemblyJob = () => Promise.resolve({ ...analysing(1), status: 'failed', error: 'no adapter' });
  const { store, presenter } = build();
  await presenter.openJob(jobId);
  expect(store.status).toBe('error');
  expect(store.loadError).toBe("We couldn't analyse these photos. Try again.");
});

test('a job the server no longer holds is an error, not a wait', async () => {
  compositesApi.getAssemblyJob = () => Promise.reject(new Error('Merged photo not found'));
  const { store, presenter } = build();
  await presenter.openJob(jobId);
  expect(store.status).toBe('error');
  expect(store.loadError).toBe("We couldn't analyse these photos. Try again.");
});

test('a saved session is restored over the carve rather than the recipe defaults', async () => {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  saveSeededSession(jobId, [0, 1]);
  const { store, presenter } = build();
  await presenter.openJob(jobId);
  expect(store.status).toBe('ready');
  expect(store.picks).toEqual([0, 1]);
});

// The analysis answers none of the tiles the reader seeded, so a reload seeds them again from the
// session - and the picks saved beside them are then the right length for the tiles.
test('a reload restores the seeded tiles along with their picks', async () => {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  const seeds = [...FIXTURE_SEEDS, { x0: 10, y0: 10, x1: 50, y1: 60 }];
  saveMergeSession(jobId, { picks: [0, 0, 1], base: 0, seeds });
  const { store, presenter } = build();
  await presenter.openJob(jobId);
  const recipe = store.recipe!;
  expect(recipe.tiles).toHaveLength(3);
  expect(recipe.tiles[2]!.map((v) => recipe.vertices[v])).toEqual([
    [10, 10],
    [50, 10],
    [50, 60],
    [10, 60],
  ]);
  expect(store.picks).toEqual([0, 0, 1]);
  expect(loadMergeSession(jobId)?.seeds).toEqual(seeds);
});

test('a recipe with no seam volume draws its tiles as they are', async () => {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  saveSeededSession(jobId);
  const { store, presenter } = build();
  await presenter.openJob(jobId);
  expect(store.unseamed).toBe(true);
  expect(store.pieces.map(({ tile }) => tile)).toEqual([0, 1]);
});

test('picks saved for another tile set are not restored onto this one', async () => {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  saveMergeSession(jobId, { picks: [0, 1, 1], base: 0, seeds: FIXTURE_SEEDS });
  const { store, presenter } = build();
  await presenter.openJob(jobId);
  expect(store.picks).toEqual([0, 0]);
});

test('a reload restores the feather the reader set, within what the page offers', async () => {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  saveMergeSession(jobId, { picks: [], base: 0, seeds: [], feather: 0.01 });
  const { store, presenter } = build();
  await presenter.openJob(jobId);
  expect(store.recipe?.feather).toBe(0.01);

  saveMergeSession(jobId, { picks: [], base: 0, seeds: [], feather: 0.03 });
  await presenter.openJob(jobId);
  expect(store.recipe?.feather).toBe(MOST_FEATHER);
});

test('reopening a finished assembly fetches it rather than any job', async () => {
  let asked = 0;
  compositesApi.getAssemblyJob = () => {
    asked++;
    return Promise.resolve(readyJobFixture());
  };
  compositesApi.getAssembly = () => Promise.resolve(finished());
  compositesApi.listFrames = () =>
    Promise.resolve([{ id: 'f1' } as PhotoSummary, { id: 'f2' } as PhotoSummary]);
  const { store, presenter } = build();
  await presenter.openExisting('photoid');
  expect(asked).toBe(0);
  expect(store.status).toBe('ready');
  expect(store.readOnly).toBe(false);
  expect(store.frames.size).toBe(2);
});

test('a missing source opens read-only and names it', async () => {
  compositesApi.getAssembly = () => Promise.resolve({ ...finished(), missingSources: ['f1'] });
  compositesApi.listFrames = () => Promise.resolve([]);
  const { store, presenter } = build();
  await presenter.openExisting('photoid');
  expect(store.readOnly).toBe(true);
  expect(store.status).toBe('read-only');
  expect(store.missingSources).toEqual(['f1']);
});
