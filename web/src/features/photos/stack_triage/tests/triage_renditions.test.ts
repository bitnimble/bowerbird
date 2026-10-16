import { expect, test } from 'bun:test';
import { autorun, runInAction } from 'mobx';
import { type PhotoSummary } from '../../../../../../src/schemas/photos';
import { openSession } from '../stack_triage';
import { StackTriagePresenter } from '../stack_triage_presenter';
import { StackTriageStore } from '../stack_triage_store';

function member(id: string): PhotoSummary {
  return {
    id,
    file_path: `${id}.arw`,
    width: 3,
    height: 2,
    triage: 'untriaged',
  } as unknown as PhotoSummary;
}

function triaging(ids: string[]): { store: StackTriageStore; presenter: StackTriagePresenter } {
  const store = new StackTriageStore(
    { viewerRenditionMode: 'library' } as never,
    { byId: new Map() } as never,
  );
  const presenter = new StackTriagePresenter(store, {} as never);
  runInAction(() => {
    store.stackId = 'stack-1';
    store.members = new Map(ids.map((id) => [id, member(id)]));
    store.session = openSession(ids);
  });
  return { store, presenter };
}

test("a batch of rebuilt renditions moves every member's frame onto its new file", () => {
  const { store, presenter } = triaging(['p', 'q']);
  const drawn: string[][] = [];
  const stop = autorun(() => drawn.push([store.srcOf('p'), store.srcOf('q')]));

  presenter.renditionsRebuilt([
    { id: 'p', stage: 'renditions', version: '2026-10-16T01:00:00.000Z' },
    { id: 'p', stage: 'tile', version: '2026-10-16T02:00:00.000Z' },
    { id: 'q', stage: 'renditions', version: '2026-10-16T03:00:00.000Z' },
    { id: 'elsewhere', stage: 'renditions', version: '2026-10-16T04:00:00.000Z' },
  ]);
  stop();

  expect(drawn).toEqual([
    ['/image/p/renditions/full', '/image/q/renditions/full'],
    ['/image/p/renditions/full?v=1792112400000', '/image/q/renditions/full?v=1792119600000'],
  ]);
  expect(store.members.get('p')?.tile_built_at).toBe('2026-10-16T02:00:00.000Z');
  expect(store.members.has('elsewhere')).toBe(false);
});
