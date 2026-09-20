import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { AssemblyRecipe } from '../../../../../../src/schemas/assembly';
import { compositesApi } from '../../../../api/composites';
import { MemoryStorage } from '../../../../test_storage';
import { ToastsPresenter } from '../../../toasts/toasts_presenter';
import { ToastsStore } from '../../../toasts/toasts_store';
import { MergePresenter } from '../merge_presenter';
import { loadMergeSession } from '../merge_storage';
import { MergeStore } from '../merge_store';
import { NO_COMPOSITOR, readyJobFixture, saveSeededSession } from './fixtures/assembly_recipe';

const jobId = 'job1';
const stubbed = {
  commitAssembly: compositesApi.commitAssembly,
  updateAssembly: compositesApi.updateAssembly,
  getAssemblyJob: compositesApi.getAssemblyJob,
};

beforeEach(() => {
  globalThis.sessionStorage = new MemoryStorage();
});
afterEach(() => {
  compositesApi.commitAssembly = stubbed.commitAssembly;
  compositesApi.updateAssembly = stubbed.updateAssembly;
  compositesApi.getAssemblyJob = stubbed.getAssemblyJob;
});

/** A presenter over a finished job, which is what the picks are saved under. */
async function build(): Promise<{ store: MergeStore; presenter: MergePresenter }> {
  compositesApi.getAssemblyJob = () => Promise.resolve(readyJobFixture());
  saveSeededSession(jobId);
  const store = new MergeStore();
  const presenter = new MergePresenter(store, new ToastsPresenter(new ToastsStore()), NO_COMPOSITOR);
  await presenter.openJob(jobId);
  return { store, presenter };
}

// The recipe is the whole request: it names its own frames by id, so a second list of them would
// be a second copy of the same thing for the server to disagree with.
test('commit posts the current recipe, with the picks folded in', async () => {
  let sent: AssemblyRecipe | null = null;
  compositesApi.commitAssembly = (recipe) => {
    sent = recipe;
    return Promise.resolve({ photoId: 'newphoto' });
  };
  const { presenter } = await build();
  presenter.pick(0, 1);
  const { photoId } = await presenter.commit();
  expect(photoId).toBe('newphoto');
  expect(sent!.sources.map((frame) => frame.photoId)).toEqual(['frame001', 'frame002']);
  expect(sent!.pick).toEqual([1, 0]);
  expect(sent!.base).toBe(0);
});

test('commit clears the session on success', async () => {
  compositesApi.commitAssembly = () => Promise.resolve({ photoId: 'newphoto' });
  const { presenter } = await build();
  await presenter.commit();
  expect(loadMergeSession(jobId)).toBeNull();
});

test('a commit that fails keeps the session, so the reader loses nothing', async () => {
  compositesApi.commitAssembly = () => Promise.reject(new Error('a source was binned'));
  const { presenter } = await build();
  await expect(presenter.commit()).rejects.toThrow('a source was binned');
  expect(loadMergeSession(jobId)).not.toBeNull();
});

test('discard clears the session and does not call commit', async () => {
  compositesApi.commitAssembly = () => Promise.reject(new Error('discard must not commit'));
  const { presenter } = await build();
  presenter.discard();
  expect(loadMergeSession(jobId)).toBeNull();
});

test('committing a reopened assembly updates it in place rather than inserting a second row', async () => {
  let updated: { id: string; recipe: AssemblyRecipe } | null = null;
  compositesApi.updateAssembly = (id, recipe) => {
    updated = { id, recipe };
    return Promise.resolve({ photoId: id });
  };
  const { presenter } = await build();
  presenter.pick(1, 1);
  const { photoId } = await presenter.commitExisting('existingid');
  expect(photoId).toBe('existingid');
  expect(updated!.id).toBe('existingid');
  expect(updated!.recipe.pick).toEqual([0, 1]);
});

test('nothing loaded is nothing to commit', async () => {
  const store = new MergeStore();
  const presenter = new MergePresenter(store, new ToastsPresenter(new ToastsStore()), NO_COMPOSITOR);
  await expect(presenter.commit()).rejects.toThrow('nothing to commit');
});
