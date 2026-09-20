import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import type { AssemblyRecipe } from '../../../../../../src/schemas/assembly';
import { compositesApi } from '../../../../api/composites';
import { MemoryStorage } from '../../../../test_storage';
import { ToastsPresenter } from '../../../toasts/toasts_presenter';
import { ToastsStore } from '../../../toasts/toasts_store';
import { MergePresenter, SETTLES_AFTER_MS } from '../merge_presenter';
import { MergeStore } from '../merge_store';
import { assemblyRecipeFixture, noSeams, triangleSeams } from './fixtures/assembly_recipe';

const live: MergePresenter[] = [];

beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
});

afterEach(() => {
  for (const presenter of live.splice(0)) presenter.finish();
});

function build(previewAssembly?: typeof compositesApi.previewAssembly): {
  store: MergeStore;
  presenter: MergePresenter;
  wanted: AssemblyRecipe[];
  settled: string[];
} {
  const store = new MergeStore();
  runInAction(() => {
    const recipe = { ...assemblyRecipeFixture(), seamVolume: 'volume' };
    store.recipe = recipe;
    store.picks = [...recipe.pick];
    store.base = recipe.base;
    store.status = 'ready';
    const none = noSeams([0, 0]);
    store.solved.set(store.keyOf([0, 0]), { seams: none, geometry: store.geometry });
    store.solved.set(store.keyOf([1, 0]), { seams: triangleSeams([1, 0], 0, 500), geometry: store.geometry });
  });
  const wanted: AssemblyRecipe[] = [];
  const settled: string[] = [];
  const preview = previewAssembly ?? ((recipe: AssemblyRecipe) => {
    wanted.push(recipe);
    return Promise.resolve({ url: `/image/drafts/lib/key/preview-${wanted.length}` });
  });
  const presenter = new MergePresenter(store, new ToastsPresenter(new ToastsStore()), {
    draw: () => undefined,
    drawSettled: (url) => settled.push(url),
  }, preview);
  live.push(presenter);
  return { store, presenter, wanted, settled };
}

/** Past the wait, and past the request the wait ends in. */
async function settledOnce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SETTLES_AFTER_MS + 30));
}

test('a pick that stands still is drawn again as the render, with the seams the page solved', async () => {
  const { presenter, wanted, settled } = build();
  presenter.pick(0, 1);
  expect(settled).toEqual([]);

  await settledOnce();
  expect(wanted).toHaveLength(1);
  expect(wanted[0]?.pick).toEqual([1, 0]);
  expect(wanted[0]?.seams?.pick).toEqual([1, 0]);
  expect(settled).toEqual(['/image/drafts/lib/key/preview-1']);
});

test('a pick the reader moves past is never rendered', async () => {
  const { presenter, wanted, settled } = build();
  presenter.pick(0, 1);
  presenter.pick(0, 0);
  presenter.pick(0, 1);

  await settledOnce();
  expect(wanted).toHaveLength(1);
  expect(settled).toHaveLength(1);
});

test('a pick set the page has no seams for is rendered without them, for the server to solve', async () => {
  const { store, presenter, wanted } = build();
  runInAction(() => store.solved.clear());
  presenter.pick(0, 1);

  await settledOnce();
  expect(wanted[0]?.seams).toBeUndefined();
});

test('nothing is rendered where there is nothing to solve against', async () => {
  const { store, presenter, wanted } = build();
  runInAction(() => (store.unseamed = true));
  presenter.pick(0, 1);

  await settledOnce();
  expect(wanted).toEqual([]);
});

test('a render nobody could build leaves the masked draw', async () => {
  const { presenter, settled } = build(() => Promise.reject(new Error('no device')));
  presenter.pick(0, 1);

  await settledOnce();
  expect(settled).toEqual([]);
});

test('leaving the page drops a render it is still waiting for', async () => {
  const { presenter, settled } = build();
  presenter.pick(0, 1);
  presenter.finish();

  await settledOnce();
  expect(settled).toEqual([]);
});
