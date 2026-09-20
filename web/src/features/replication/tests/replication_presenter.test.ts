// What the replication UI does with what the server says, against a mocked
// client: the sibling refreshes a session triggers, and the two ways a
// divergence ends up on screen (docs/replication.md §5.3, §7.3).
import { beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { type Transfer } from '../../../../../src/schemas/blobs';
import { type Library } from '../../../../../src/schemas/libraries';
import { type EditConflict } from '../../../../../src/schemas/photo_edits';
import { type PairedPeer, type PeersResponse } from '../../../../../src/schemas/replication';
import { blobsApi } from '../../../api/blobs';
import { photoEditsApi } from '../../../api/photo_edits';
import { replicationApi } from '../../../api/replication';
import { LibrariesStore } from '../../libraries/libraries_store';
import { ReplicationPresenter } from '../replication_presenter';
import { ReplicationStore } from '../replication_store';

const PEER: PairedPeer = {
  peer_id: 'peer000000000001',
  name: 'Macbook',
  paired_at: '2026-01-01T00:00:00.000Z',
  last_replicated_at: null,
  last_error: null,
  wants_originals: true,
};

function peersAnswer(peers: PairedPeer[], syncOriginals = true): Promise<PeersResponse> {
  return Promise.resolve({ peers, sync_originals: syncOriginals });
}

function candidate(sessionId: string, device: string): EditConflict {
  return {
    photo_id: 'photo1',
    library_id: 'lib',
    file_path: 'Day1/one.arw',
    session_id: sessionId,
    device,
    edited_at: '2026-02-01T00:00:00.000Z',
    edits: 4,
    doc: {} as EditConflict['doc'],
  };
}

interface Harness {
  store: ReplicationStore;
  librariesStore: LibrariesStore;
  presenter: ReplicationPresenter;
  reloads: () => number;
  libraryLoads: () => number;
  toasts: string[];
}

// `api` is a module singleton, so this is the seam.
function harness(): Harness {
  const store = new ReplicationStore();
  const librariesStore = new LibrariesStore();
  librariesStore.libraries = [{ id: 'lib', name: 'Trip' } as Library];
  let reloads = 0;
  let libraryLoads = 0;
  const toasts: string[] = [];
  const presenter = new ReplicationPresenter(
    store,
    librariesStore,
    { load: () => Promise.resolve(void libraryLoads++) },
    { reload: () => Promise.resolve(void reloads++) },
    {
      show: (message: string) => toasts.push(message),
      showError: (message: string) => toasts.push(message),
    },
  );
  return { store, librariesStore, presenter, reloads: () => reloads, libraryLoads: () => libraryLoads, toasts };
}

beforeEach(() => {
  replicationApi.listPeers = () => peersAnswer([PEER]);
  replicationApi.listAllPeers = () => Promise.resolve({ libraries: [{ library_id: 'lib', peers: [PEER], sync_originals: true }] });
  blobsApi.listTransfers = () => Promise.resolve([]);
  photoEditsApi.listConflicts = () => Promise.resolve([]);
});

test('a session that brought nothing over leaves the grid alone', async () => {
  const { presenter, reloads } = harness();
  replicationApi.replicate = () => Promise.resolve({ applied: 0, peers: 1 });

  await presenter.replicate('lib');

  expect(reloads()).toBe(0);
});

test('a session that applied changes re-reads the grid, because rows moved under it', async () => {
  const { presenter, reloads } = harness();
  replicationApi.replicate = () => Promise.resolve({ applied: 12, peers: 1 });

  await presenter.replicate('lib');

  expect(reloads()).toBe(1);
});

test('a library nobody can be reached for says so rather than reporting success', async () => {
  const { presenter, toasts } = harness();
  replicationApi.replicate = () => Promise.resolve({ applied: 0, peers: 0 });

  await presenter.replicate('lib');

  expect(toasts.some((message) => message.includes("couldn't reach another device"))).toBe(true);
});

test('both candidates of one divergence are one entry, not two', async () => {
  const { store, presenter } = harness();
  photoEditsApi.listConflicts = () => Promise.resolve([candidate('here', 'Desktop'), candidate('there', 'Macbook')]);

  await presenter.loadConflicts();

  expect(store.conflictedPhotos).toHaveLength(1);
  expect(store.conflictedPhotos[0]?.candidates.map((c) => c.device)).toEqual(['Desktop', 'Macbook']);
});

test('keeping a candidate clears the divergence and re-reads the picture it changed', async () => {
  const { store, presenter, reloads } = harness();
  photoEditsApi.listConflicts = () => Promise.resolve([candidate('here', 'Desktop'), candidate('there', 'Macbook')]);
  await presenter.loadConflicts();

  const kept: string[] = [];
  photoEditsApi.keepCandidate = (photoId: string, sessionId: string) => {
    kept.push(`${photoId}/${sessionId}`);
    photoEditsApi.listConflicts = () => Promise.resolve([]);
    return Promise.resolve();
  };

  await presenter.keep('photo1', 'there');

  expect(kept).toEqual(['photo1/there']);
  expect(store.conflictedPhotos).toEqual([]);
  expect(reloads()).toBe(1);
});

// The server announces what its own timer did, so nothing here asks on a timer of
// its own - and a device that replicates nothing is told nothing, which is the
// whole of what it should cost.
test('a session the server announces re-reads that library, and only libraries this page has', async () => {
  const { store, presenter } = harness();
  const asked: string[] = [];
  replicationApi.listPeers = (libraryId: string) => {
    asked.push(libraryId);
    return peersAnswer([{ ...PEER, last_error: 'connection refused' }]);
  };

  await presenter.libraryChanged('lib');
  // A library this page never had: asking would answer 404 into an error toast.
  await presenter.libraryChanged('somebody-elses');

  expect(asked).toEqual(['lib']);
  expect(store.failingPeers).toBe(1);
});

// A library list re-read that changed nothing is not news: the store replaces the
// array on every load, so an identity comparison would put the whole install back
// on the wire after every scan.
test('following the library list asks again only when a library came or went', async () => {
  const { presenter, librariesStore } = harness();
  let asks = 0;
  replicationApi.listAllPeers = () => {
    asks++;
    return Promise.resolve({ libraries: [] });
  };

  const lists = (libraries: Library[]): void =>
    runInAction(() => {
      librariesStore.libraries = libraries;
    });

  presenter.follow();
  await Promise.resolve();
  // The same libraries, re-read: every scan replaces the array.
  lists([{ id: 'lib', name: 'Trip renamed' } as Library]);
  await Promise.resolve();
  lists([{ id: 'lib', name: 'Trip' } as Library, { id: 'second', name: 'Studio' } as Library]);
  await Promise.resolve();
  presenter.unfollow();

  expect(asks).toBe(2);
});

// The gate on every strip, badge and panel is "does this library have a peer",
// and a library that replicates with nobody is simply absent from the answer.
test('the whole install is one request, and a library with no peers is not in it', async () => {
  const { store, presenter } = harness();
  let asks = 0;
  replicationApi.listAllPeers = () => {
    asks++;
    return Promise.resolve({ libraries: [{ library_id: 'lib', peers: [PEER], sync_originals: false }] });
  };

  await presenter.reload();

  expect(asks).toBe(1);
  expect(store.hasPeers('lib')).toBe(true);
  expect(store.syncsOriginals('lib')).toBe(false);
  expect(store.hasPeers('solo')).toBe(false);
  expect(store.syncsOriginals('solo')).toBe(true);
});

// A library that stops replicating leaves a strip behind if the answer is merged
// into what was there rather than replacing it.
test('a library that lost its peers stops rendering as one that has them', async () => {
  const { store, presenter } = harness();
  await presenter.reload();
  expect(store.hasPeers('lib')).toBe(true);

  replicationApi.listAllPeers = () => Promise.resolve({ libraries: [] });
  await presenter.reload();

  expect(store.hasPeers('lib')).toBe(false);
});

test('a peer whose sessions are failing is counted wherever the reader is', async () => {
  const { store, presenter } = harness();
  replicationApi.listPeers = () => peersAnswer([{ ...PEER, last_error: 'connection refused' }]);

  await presenter.loadPeers('lib');

  expect(store.failingPeers).toBe(1);
});

test('a queued fetch is not queued again while it is still running', async () => {
  const { store, presenter } = harness();
  const running: Transfer = {
    id: 't1',
    library_id: 'lib',
    photo_id: 'photo1',
    peer_id: PEER.peer_id,
    direction: 'pull',
    state: 'active',
    bytes_done: 10,
    bytes_total: 100,
  } as Transfer;
  blobsApi.listTransfers = () => Promise.resolve([running]);
  await presenter.refreshTransfers();

  let asks = 0;
  blobsApi.fetchOriginal = () => {
    asks++;
    return Promise.resolve(undefined);
  };
  await presenter.fetchOriginal('photo1');

  expect(asks).toBe(0);
  expect(store.pullFor('photo1')?.id).toBe('t1');
});

// §9.1: browsing a peer records nothing, so a reader who changes their mind at
// the list has left no trace on either device.
test('browsing hands back what the peer offers, without touching the library list', async () => {
  const { presenter, reloads } = harness();
  replicationApi.browseRemote = () =>
    Promise.resolve({
      peer_id: PEER.peer_id,
      name: 'Desktop',
      clock_ms: 0,
      clock_skew_ms: 0,
      libraries: [{ id: 'lib', name: 'Trip', photo_count: 12, read_only: false, replicating: true }],
    });

  const browsed = await presenter.browse('http://desktop:5173');

  expect(browsed?.libraries).toHaveLength(1);
  expect(browsed?.name).toBe('Desktop');
  expect(reloads()).toBe(0);
});

test('an address that answers nothing says so and adds no library', async () => {
  const { store, presenter } = harness();
  replicationApi.browseRemote = () => Promise.reject(new Error('Unable to connect'));

  const browsed = await presenter.browse('http://nowhere:5173');

  expect(browsed).toBeNull();
  expect(store.linkError).toContain('Unable to connect');
});

test('adding one re-reads the library list, since a whole catalogue just arrived', async () => {
  const { presenter, toasts } = harness();
  const asked: unknown[] = [];
  replicationApi.addReplica = (address, libraryId, rootPath, syncOriginals) => {
    asked.push({ address, libraryId, rootPath, syncOriginals });
    return Promise.resolve({ library_id: libraryId, peer_id: PEER.peer_id, applied: 240 });
  };

  const added = await presenter.addReplica('http://desktop:5173', 'lib', '/photos/trip', false);

  expect(added).toBe(true);
  expect(asked).toEqual([
    { address: 'http://desktop:5173', libraryId: 'lib', rootPath: '/photos/trip', syncOriginals: false },
  ]);
  expect(toasts[0]).toBe('Synced library added with 240 changes so far.');
});

// The library is committed before its catalogue arrives, so one that failed
// part-way has left one behind and the list has to be re-read either way.
test('an add that failed still re-reads the library list', async () => {
  const { store, presenter, libraryLoads } = harness();
  replicationApi.addReplica = () => Promise.reject(new Error('/photos/trip is not empty'));

  const added = await presenter.addReplica('http://desktop:5173', 'lib', '/photos/trip', true);

  expect(added).toBe(false);
  expect(store.linkError).toContain('not empty');
  expect(libraryLoads()).toBe(1);
});

test('what this device keeps is read off the same request as its peers', async () => {
  const { store, presenter } = harness();
  replicationApi.listPeers = () => peersAnswer([PEER], false);

  await presenter.loadPeers('lib');

  expect(store.syncsOriginals('lib')).toBe(false);
  // A library nobody has answered for is one that keeps its own, which is what
  // every library that does not replicate does.
  expect(store.syncsOriginals('other')).toBe(true);
});

test('turning the setting off re-reads it rather than assuming the write landed', async () => {
  const { store, presenter } = harness();
  const asked: boolean[] = [];
  replicationApi.setSyncOriginals = (_libraryId, value) => {
    asked.push(value);
    replicationApi.listPeers = () => peersAnswer([PEER], value);
    return Promise.resolve({ cancelled: 0 });
  };

  await presenter.setSyncOriginals('lib', false);

  expect(asked).toEqual([false]);
  expect(store.syncsOriginals('lib')).toBe(false);
});

test('turning it off says what it stopped, because those transfers were the reason', async () => {
  const { presenter, toasts } = harness();
  replicationApi.setSyncOriginals = () => Promise.resolve({ cancelled: 12 });

  await presenter.setSyncOriginals('lib', false);

  expect(toasts[0]).toBe('Stopped 12 originals that were still on their way here.');
});

test('an eviction the peer would not confirm reports what was kept, not just what went', async () => {
  const { store, presenter, toasts, reloads } = harness();
  store.peersByLibrary.set('lib', [PEER]);
  blobsApi.evictOriginals = () =>
    Promise.resolve({
      evicted: ['photo1'],
      refused: [{ photo_id: 'photo2', reason: 'peer could not verify possession of a matching copy' }],
    });

  await presenter.removeLocalCopies({ photo_ids: ['photo1', 'photo2'] }, 'lib', PEER.peer_id);

  expect(toasts[0]).toBe('Removed 1 local copy; kept 1 local copy because Macbook couldn\'t confirm a matching copy.');
  // The rows that lost their file are `is_missing` now, so the grid is stale.
  expect(reloads()).toBe(1);
});

test('an eviction nothing survived does not claim a partial success', async () => {
  const { store, presenter, toasts } = harness();
  store.peersByLibrary.set('lib', [PEER]);
  blobsApi.evictOriginals = () =>
    Promise.resolve({ evicted: [], refused: [{ photo_id: 'photo1', reason: 'the original is not on this device' }] });

  await presenter.removeLocalCopies({ photo_ids: ['photo1'] }, 'lib', PEER.peer_id);

  expect(toasts[0]).toBe('Macbook could not confirm a copy of 1 photo.');
});
