import { afterEach, expect, test } from 'bun:test';
import { when } from 'mobx';
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

test('backup loads before Settings, refreshes on each stream open and reads backup invalidations', async () => {
  const sources: Source[] = [];
  class Source {
    private readonly handlers = new Map<string, (event: { data: string }) => void>();
    constructor() {
      sources.push(this);
    }
    addEventListener(kind: string, handler: (event: { data: string }) => void): void {
      this.handlers.set(kind, handler);
    }
    emit(kind: string, data = ''): void {
      this.handlers.get(kind)?.({ data });
    }
    close(): void {}
  }
  Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: Source });
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
    },
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
