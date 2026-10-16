import { afterEach, expect, test } from 'bun:test';
import { when } from 'mobx';
import { type RenditionEvent } from '../../../../../src/schemas/events';
import { backupApi } from '../../../api/backup';
import { restoreApiAfterTests } from '../../../test_api';
import { BackupPresenter } from '../../backup/backup_presenter';
import { BackupStore } from '../../backup/backup_store';
import { backupStatus } from '../../backup/tests/backup_fixture';
import { EventsPresenter } from '../events_presenter';

restoreApiAfterTests();
const sourceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'EventSource');
const sessions: EventsPresenter[] = [];
afterEach(() => {
  sessions.splice(0).forEach((events) => events.disconnect());
  if (sourceDescriptor == null) Reflect.deleteProperty(globalThis, 'EventSource');
  else Object.defineProperty(globalThis, 'EventSource', sourceDescriptor);
});

class Source {
  static readonly opened: Source[] = [];
  private readonly handlers = new Map<string, (event: { data: string }) => void>();
  constructor() {
    Source.opened.push(this);
  }
  addEventListener(kind: string, handler: (event: { data: string }) => void): void {
    this.handlers.set(kind, handler);
  }
  emit(kind: string, data = ''): void {
    this.handlers.get(kind)?.({ data });
  }
  close(): void {}
}

function useFakeEventSource(): void {
  Source.opened.length = 0;
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: Source });
}

test('backup loads before Settings, refreshes on each stream open and reads backup invalidations', async () => {
  useFakeEventSource();
  const sources = Source.opened;
  const store = new BackupStore();
  const backup = new BackupPresenter(
    store,
    { reload: async () => {} },
    { show: () => {}, showError: () => {} },
  );
  let server = backupStatus();
  let reads = 0;
  backupApi.list = async () => {
    reads++;
    return { backups: [server] };
  };
  let reachable = 0;
  const events = new EventsPresenter(
    {
      serverReachable: () => {
        reachable++;
      },
      renditionsRebuilt: () => {},
      renditionFetch: () => {},
      compositeProgressed: () => {},
      reload: async () => {},
    },
    { load: async () => {} },
    { libraryChanged: async () => {}, reload: async () => {} },
    { renditionsRebuilt: () => {} },
    { progressed: () => {} },
    { load: async () => {} },
    backup,
  );
  sessions.push(events);
  events.connect();
  await when(() => store.loaded, { timeout: 1000 });
  expect(reads).toBe(1);
  const source = sources[0];
  if (source == null) throw new Error('no event source');
  server = backupStatus({ status: 'waiting' });
  source.emit('open');
  await when(() => store.statusOf('lib') === server, { timeout: 1000 });
  expect(reachable).toBe(0);
  server = backupStatus({ status: 'attention' });
  source.emit('open');
  await when(() => store.statusOf('lib') === server, { timeout: 1000 });
  expect(reachable).toBe(1);
  server = backupStatus({ status: 'paused' });
  source.emit('backup', JSON.stringify({ library_id: 'lib' }));
  await when(() => store.statusOf('lib') === server, { timeout: 1000 });
  expect(reads).toBe(4);
});

test('a finished scan re-reads the grid and the library counts', () => {
  useFakeEventSource();
  backupApi.list = async () => ({ backups: [] });
  const reloads: string[] = [];
  const events = new EventsPresenter(
    {
      serverReachable: () => {},
      renditionsRebuilt: () => {},
      renditionFetch: () => {},
      compositeProgressed: () => {},
      reload: async (activity) => {
        reloads.push(`photos ${activity}`);
      },
    },
    {
      load: async (activity) => {
        reloads.push(`libraries ${activity}`);
      },
    },
    { libraryChanged: async () => {}, reload: async () => {} },
    { renditionsRebuilt: () => {} },
    { progressed: () => {} },
    { load: async () => {} },
    new BackupPresenter(
      new BackupStore(),
      { reload: async () => {} },
      { show: () => {}, showError: () => {} },
    ),
  );
  sessions.push(events);
  events.connect();

  Source.opened[0]?.emit('scan', JSON.stringify({ library_id: 'lib' }));

  expect(reloads).toEqual(['photos background', 'libraries background']);
});

test('a batch of rewritten renditions reaches the grid and a triage session whole', () => {
  useFakeEventSource();
  backupApi.list = async () => ({ backups: [] });
  const grid: RenditionEvent[][] = [];
  const triage: RenditionEvent[][] = [];
  const events = new EventsPresenter(
    {
      serverReachable: () => {},
      renditionsRebuilt: (written) => grid.push([...written]),
      renditionFetch: () => {},
      compositeProgressed: () => {},
      reload: async () => {},
    },
    { load: async () => {} },
    { libraryChanged: async () => {}, reload: async () => {} },
    { renditionsRebuilt: (written) => triage.push([...written]) },
    { progressed: () => {} },
    { load: async () => {} },
    new BackupPresenter(
      new BackupStore(),
      { reload: async () => {} },
      { show: () => {}, showError: () => {} },
    ),
  );
  sessions.push(events);
  events.connect();
  const written: RenditionEvent[] = [
    { id: 'a', stage: 'tile', version: '2026-10-16T01:00:00.000Z' },
    { id: 'a', stage: 'renditions', version: '2026-10-16T01:00:01.000Z' },
    { id: 'b', stage: 'renditions', version: '2026-10-16T01:00:02.000Z' },
  ];

  Source.opened[0]?.emit('renditions', JSON.stringify({ written }));

  expect(grid).toEqual([written]);
  expect(triage).toEqual([written]);
});
