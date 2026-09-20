// Which side of the screen each half of a round is drawn on. The tournament moves
// a winner to the front of the pool, so half the decisive verdicts would slide the
// photograph that was kept across the screen and put the new one where it had
// been - two halves changing at once, and nothing to say which was replaced.
import { expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { openSession } from '../stack_triage';
import { StackTriagePresenter } from '../stack_triage_presenter';
import { StackTriageStore } from '../stack_triage_store';

const photos = {
  setTriage: () => Promise.resolve(true),
  reload: () => Promise.resolve(),
} as never;

function member(id: string): PhotoSummary {
  return { id, file_path: `${id}.arw`, width: 3, height: 2, triage: 'untriaged' } as unknown as PhotoSummary;
}

function build(ids: string[]): { store: StackTriageStore; presenter: StackTriagePresenter } {
  const store = new StackTriageStore({ viewerRenditionMode: 'library' } as never, { byId: new Map() } as never);
  const presenter = new StackTriagePresenter(store, photos);
  runInAction(() => {
    store.stackId = 'stack-1';
    store.members = new Map(ids.map((id) => [id, member(id)]));
    store.baseline = new Map(ids.map((id) => [id, 'untriaged' as const]));
    store.session = openSession(ids);
  });
  return { store, presenter };
}

test('the photo a verdict keeps is drawn on the side it was already on', async () => {
  const { store, presenter } = build(['p', 'q', 'r']);
  expect(store.sides).toEqual(['p', 'q']);

  // The right-hand photo wins. It is the pool's front from here, but it stays on
  // the right, and the challenger arrives in the half that was vacated.
  await presenter.judge('b');
  expect(store.sides).toEqual(['r', 'q']);
});

test('a verdict names the side of the screen, not the slot of the round', async () => {
  const { store, presenter } = build(['p', 'q', 'r']);
  await presenter.judge('b');

  // `q` is on the right of a swapped round, so Pick A is `r` - and it is `q`
  // that a rejection has to reach.
  await presenter.judge('a');
  expect(store.pool.map((photo) => photo.id)).toEqual(['r']);
});

test('a round sharing nothing with the one on screen is drawn in the tournament order', async () => {
  const { store, presenter } = build(['p', 'q', 'r', 's']);

  await presenter.judge('both');
  expect(store.sides).toEqual(['r', 's']);
});

test('an undo draws the round it returns to around the photo already on screen', async () => {
  const { store, presenter } = build(['p', 'q', 'r']);
  await presenter.judge('b');
  expect(store.sides).toEqual(['r', 'q']);

  await presenter.undo();
  expect(store.sides).toEqual(['p', 'q']);
});
