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

test('a stack of finished pictures is judged at their own files on a library that pre-renders', () => {
  const pool = (finished: Partial<PhotoSummary>): StackTriageStore => {
    const store = new StackTriageStore(
      { viewerRenditionMode: 'remember', lastViewerRendition: 'max' } as never,
      { byId: new Map([['lib', { rendition_source: 'render' }]]) } as never,
    );
    runInAction(() => {
      store.members = new Map(
        ['p', 'q'].map((id) => [id, { ...member(id), library_id: 'lib', ...finished }]),
      );
    });
    return store;
  };

  expect(pool({ is_raw: false, has_embedded: true }).rendition).toBe('embedded');
  expect(pool({ is_raw: true, has_embedded: true }).rendition).toBe('full');
});

test("a member's own file this browser cannot draw takes the pool to the render, which a 404 builds", () => {
  const built: string[] = [];
  const store = new StackTriageStore(
    { viewerRenditionMode: 'embedded' } as never,
    { byId: new Map() } as never,
  );
  const presenter = new StackTriagePresenter(store, {
    buildMissingRendition: (photoId: string, rendition: string) => {
      built.push(`${rendition} of ${photoId}`);
      return Promise.resolve();
    },
  } as never);
  runInAction(() => {
    store.members = new Map(
      ['p', 'q'].map((id) => [id, { ...member(id), is_raw: false, has_embedded: true }]),
    );
  });

  presenter.frameMissing('p', false);
  expect(store.rendition).toBe('embedded');
  presenter.frameMissing('p', true);
  expect(store.rendition).toBe('full');
  expect(built).toEqual([]);
  presenter.frameMissing('q', false);
  expect(built).toEqual(['full of q']);
});
