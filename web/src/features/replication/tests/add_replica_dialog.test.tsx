import { afterEach, beforeEach, expect, test } from 'bun:test';
import { useEffect } from 'react';
import { DEFAULT_LIBRARY_SETTINGS, type Library } from '../../../../../src/schemas/libraries';
import { type AddReplicaRequest, type RemoteLibrary } from '../../../../../src/schemas/replication';
import { blobsApi } from '../../../api/blobs';
import { browseApi } from '../../../api/browse';
import { librariesApi } from '../../../api/libraries';
import { replicationApi } from '../../../api/replication';
import { registerDom } from '../../../test_dom';
import { restoreApiAfterTests } from '../../../test_api';

registerDom();
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { StoresProvider, usePresenters } = await import('../../../app/stores_context');
const { AddReplicaDialog } = await import('../add_replica_dialog');

restoreApiAfterTests();
afterEach(cleanup);

let here: Library[] = [];

function libraryHere(id: string, over: Partial<Library> = {}): Library {
  return {
    id,
    root_path: `/fixture/${id}`,
    bin_name: 'Bin',
    read_only: false,
    name: id,
    ordering: 'taken_asc',
    rendition_source: 'render',
    rendition_hdr: true,
    render_skip_full: [],
    render_skip_max: [],
    denoiser: 'galosh',
    include_subfolders: true,
    include_non_raw: false,
    auto_stack: true,
    last_synced_at: null,
    photo_count: 0,
    missing_photo_count: 0,
    unavailable_photo_count: 0,
    rendered_photo_count: 0,
    ...over,
  };
}

const TRIP: RemoteLibrary = {
  id: 'library1',
  name: 'Trip',
  photo_count: 12,
  read_only: false,
  replicating: true,
};
const ARCHIVE: RemoteLibrary = {
  id: 'library2',
  name: 'Archive',
  photo_count: 3,
  read_only: true,
  replicating: false,
};

/** `fail` gives a request's error, and `committed` whether its library still landed here. */
function recordAdds(
  fail: (request: AddReplicaRequest) => { error: Error; committed: boolean } | null = () => null,
): AddReplicaRequest[] {
  const requests: AddReplicaRequest[] = [];
  replicationApi.addReplica = (request) => {
    requests.push(request);
    const failure = fail(request);
    if (failure == null || failure.committed) here.push(libraryHere(request.library_id));
    if (failure != null) return Promise.reject(failure.error);
    return Promise.resolve({
      library_id: request.library_id,
      peer_id: 'peer000000000001',
      applied: 0,
    });
  };
  return requests;
}

function offering(libraries: RemoteLibrary[]): void {
  replicationApi.browseRemote = () =>
    Promise.resolve({
      peer_id: 'peer000000000001',
      name: 'Desktop',
      address: 'http://desktop:5173',
      clock_ms: Date.now(),
      clock_skew_ms: 0,
      libraries,
    });
}

async function asThinShell(run: () => Promise<void>): Promise<void> {
  const userAgent = navigator.userAgent;
  const bridge = globalThis as { __TAURI__?: unknown };
  Object.defineProperty(navigator, 'userAgent', {
    value: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
    configurable: true,
  });
  bridge.__TAURI__ = { core: { invoke: async () => null } };
  try {
    await run();
  } finally {
    delete bridge.__TAURI__;
    Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
  }
}

beforeEach(() => {
  here = [];
  librariesApi.list = () => Promise.resolve([...here]);
  librariesApi.getDefaults = () => Promise.resolve(DEFAULT_LIBRARY_SETTINGS);
  blobsApi.listTransfers = () => Promise.resolve([]);
  browseApi.get = (path = '/') => Promise.resolve({ path, parent: null, directories: [] });
  replicationApi.listPeers = () => Promise.resolve({ peers: [], sync_originals: true });
  offering([TRIP]);
});

/** The libraries this device already has, read as the app reads them on start. */
function Loaded(): null {
  const { libraries } = usePresenters();
  useEffect(() => void libraries.load(), [libraries]);
  return null;
}

async function open(onOpenChange: (open: boolean) => void = () => {}): Promise<void> {
  await act(async () => {
    render(
      <StoresProvider>
        <Loaded />
        <AddReplicaDialog open onOpenChange={onOpenChange} />
      </StoresProvider>,
    );
  });
}

async function press(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

async function connect(): Promise<void> {
  const field = screen.getByRole('textbox', { name: 'Device address' });
  await act(async () => {
    fireEvent.change(field, { target: { value: 'desktop:5173' } });
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Enter' });
  });
}

async function pick(...names: string[]): Promise<void> {
  await connect();
  for (const name of names) {
    await act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name }));
    });
  }
}

async function chooseFolder(path: string): Promise<void> {
  await press('Choose folder');
  const picker = within(screen.getByRole('dialog', { name: 'Choose folder' }));
  await act(async () => {
    fireEvent.change(picker.getByRole('textbox', { name: 'Library root' }), {
      target: { value: path },
    });
    fireEvent.click(picker.getByRole('button', { name: 'Choose folder' }));
  });
}

async function chooseOriginals(name: 'Sync original RAWs' | 'Sync thumbnails only'): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name }));
  });
}

function chosenOriginals(): string | null {
  return (
    screen.getAllByRole('radio').find((radio) => radio.getAttribute('aria-checked') === 'true')
      ?.textContent ?? null
  );
}

function card(name: string): HTMLElement {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) });
}

const request = (over: Partial<AddReplicaRequest>): AddReplicaRequest => ({
  address: 'http://desktop:5173',
  library_id: 'library1',
  root_path: '/fixture/trip',
  sync_originals: true,
  denoiser: 'galosh',
  render_skip_full: [],
  ...over,
});

test('Enter browses the trimmed address once, and not at all while it is blank', async () => {
  const asked: string[] = [];
  const answer = Promise.withResolvers<Awaited<ReturnType<typeof replicationApi.browseRemote>>>();
  replicationApi.browseRemote = (address) => {
    asked.push(address);
    return answer.promise;
  };
  await open();
  const field = screen.getByRole('textbox', { name: 'Device address' });

  for (const value of ['', '   ', ' desktop:5173 ']) {
    await act(async () => {
      fireEvent.change(field, { target: { value } });
    });
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' });
    });
  }
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Enter' });
  });

  expect(asked).toEqual(['desktop:5173']);
});

test('reconnecting to another device drops the library picked on the first', async () => {
  await open();
  await pick('Trip');
  await press('Next');
  await press('Back');
  await press('Back');
  await press('Next');

  expect(screen.getByRole('checkbox', { name: 'Trip' }).matches(':checked')).toBe(false);
  expect(screen.getByRole('button', { name: 'Next' }).matches(':disabled')).toBe(true);
});

test("1 library sets its folder and originals on one screen, and takes this device's Rendering settings", async () => {
  here = [libraryHere('home', { denoiser: 'pmrid', render_skip_full: ['sharpen'] })];
  const requests = recordAdds();
  await open();
  await pick('Trip');
  await press('Next');

  screen.getByText('Select a folder on your device where this library will be synced to.');
  expect(screen.getByRole('button', { name: 'Add "Trip"' }).matches(':disabled')).toBe(true);
  expect(chosenOriginals()).toBe('Sync original RAWs');
  expect(screen.queryByRole('combobox', { name: 'Denoiser' })).toBeNull();
  await chooseFolder('/fixture/trip');
  await chooseOriginals('Sync thumbnails only');
  await press('Add "Trip"');

  expect(requests).toEqual([
    request({ sync_originals: false, denoiser: 'pmrid', render_skip_full: ['sharpen'] }),
  ]);
});

test('a library left on the default keeps its originals', async () => {
  const requests = recordAdds();
  await open();
  await pick('Trip');
  await press('Next');
  await chooseFolder('/fixture/trip');
  await press('Add "Trip"');

  expect(requests).toEqual([request({})]);
});

test('a library picked again after being dropped has to be configured again', async () => {
  offering([TRIP, ARCHIVE]);
  await open();
  await pick('Archive, read-only', 'Trip');
  await press('Next');
  await act(async () => {
    fireEvent.click(card('Trip'));
  });
  await chooseFolder('/fixture/trip');
  await press('Save');
  const toggleTrip = (): Promise<void> =>
    act(async () => {
      fireEvent.click(screen.getByRole('checkbox', { name: 'Trip' }));
    });
  await press('Back');
  await toggleTrip();
  await press('Next');
  await press('Back');
  await toggleTrip();
  await press('Next');

  expect(card('Trip').textContent).toBe('TripConfigure');
});

test('a read-only library asks only for its folder, and is added without originals', async () => {
  offering([ARCHIVE]);
  const requests = recordAdds();
  await open();
  await pick('Archive, read-only');
  await press('Next');
  await chooseFolder('/fixture/archive');

  expect(screen.queryByRole('radio', { name: 'Sync original RAWs' })).toBeNull();
  await press('Add "Archive"');

  expect(requests).toEqual([
    request({ library_id: 'library2', root_path: '/fixture/archive', sync_originals: false }),
  ]);
});

test('several libraries are configured one at a time from their cards, then finished together', async () => {
  offering([TRIP, ARCHIVE]);
  const requests = recordAdds();
  let closed = false;
  await open((open) => (closed = !open));
  await pick('Archive, read-only', 'Trip');
  await press('Next');

  expect(card('Trip').textContent).toContain('Configure');
  expect(card('Archive').textContent).toContain('Configure');
  expect(screen.getByRole('button', { name: 'Finish' }).matches(':disabled')).toBe(true);

  await act(async () => {
    fireEvent.click(card('Trip'));
  });
  screen.getByText('Trip');
  await chooseFolder('/fixture/trip');
  await chooseOriginals('Sync thumbnails only');
  await press('Save');

  expect(card('Trip').textContent).toBe('TripConfigured');
  expect(screen.getByRole('button', { name: 'Finish' }).matches(':disabled')).toBe(true);

  await act(async () => {
    fireEvent.click(card('Archive'));
  });
  await chooseFolder('/fixture/archive');
  await press('Save');
  await press('Finish');

  expect(requests).toEqual([
    request({ sync_originals: false }),
    request({ library_id: 'library2', root_path: '/fixture/archive', sync_originals: false }),
  ]);
  expect(closed).toBe(true);
});

test('backing out of a library leaves it to configure, and reopening it shows its choices', async () => {
  offering([TRIP, ARCHIVE]);
  await open();
  await pick('Archive, read-only', 'Trip');
  await press('Next');
  await act(async () => {
    fireEvent.click(card('Trip'));
  });
  await chooseFolder('/fixture/trip');
  await press('Back');

  expect(card('Trip').textContent).toBe('TripConfigure');
  await act(async () => {
    fireEvent.click(card('Trip'));
  });
  screen.getByText('/fixture/trip');
});

async function finishBothFailingOnArchive(committed: boolean): Promise<{
  requests: AddReplicaRequest[];
  closed: () => boolean;
}> {
  offering([TRIP, ARCHIVE]);
  const requests = recordAdds((request) =>
    request.library_id === 'library2' && requests.length === 2
      ? { error: new Error('Unable to connect'), committed }
      : null,
  );
  let closed = false;
  await open((open) => (closed = !open));
  await pick('Archive, read-only', 'Trip');
  await press('Next');
  await act(async () => {
    fireEvent.click(card('Trip'));
  });
  await chooseFolder('/fixture/trip');
  await press('Save');
  await act(async () => {
    fireEvent.click(card('Archive'));
  });
  await chooseFolder('/fixture/archive');
  await press('Save');
  await press('Finish');
  return { requests, closed: () => closed };
}

test('a failed finish marks what was added, and retries only the rest', async () => {
  const { requests, closed } = await finishBothFailingOnArchive(false);

  expect(closed()).toBe(false);
  screen.getByText(/Unable to connect/);
  expect(card('Trip').textContent).toBe('TripAdded');
  expect(card('Trip').matches(':disabled')).toBe(true);
  expect(card('Archive').textContent).toBe('ArchiveConfigured');
  expect(screen.getByRole('button', { name: 'Back' }).matches(':disabled')).toBe(true);

  await press('Finish');
  expect(requests.map((request) => request.library_id)).toEqual([
    'library1',
    'library2',
    'library2',
  ]);
  expect(closed()).toBe(true);
});

test('a finish that failed after reaching this device is not offered again', async () => {
  const { requests, closed } = await finishBothFailingOnArchive(true);

  expect(requests.map((request) => request.library_id)).toEqual(['library1', 'library2']);
  expect(closed()).toBe(true);
});

test('a library already on this device cannot be picked', async () => {
  here = [libraryHere('library1')];
  await open();
  await connect();

  const trip = screen.getByRole('checkbox', { name: 'Trip' });
  expect(trip.matches(':disabled')).toBe(true);
  screen.getByText('Already on this device');
});

test('reopening starts the originals back at Sync original RAWs', async () => {
  const dialog = (open: boolean): JSX.Element => (
    <StoresProvider>
      <AddReplicaDialog open={open} onOpenChange={() => {}} />
    </StoresProvider>
  );
  const view = render(dialog(true));
  const toOriginals = async (): Promise<void> => {
    await pick('Trip');
    await press('Next');
  };
  await toOriginals();
  await chooseOriginals('Sync thumbnails only');
  expect(chosenOriginals()).toBe('Sync thumbnails only');

  view.rerender(dialog(false));
  view.rerender(dialog(true));
  await toOriginals();
  expect(chosenOriginals()).toBe('Sync original RAWs');
});

test('the mobile app adds several libraries straight from the list, without folders or originals', async () => {
  await asThinShell(async () => {
    offering([TRIP, ARCHIVE]);
    const requests = recordAdds();
    await open();
    await pick('Archive, read-only', 'Trip');
    await press('Finish');

    expect(requests).toEqual([
      {
        address: 'http://desktop:5173',
        library_id: 'library1',
        sync_originals: false,
        denoiser: 'galosh',
        render_skip_full: [],
      },
      {
        address: 'http://desktop:5173',
        library_id: 'library2',
        sync_originals: false,
        denoiser: 'galosh',
        render_skip_full: [],
      },
    ]);
  });
});

test('the mobile app adds 1 library straight from the list', async () => {
  await asThinShell(async () => {
    const requests = recordAdds();
    await open();
    await pick('Trip');
    await press('Add "Trip"');

    expect(requests.map((request) => request.library_id)).toEqual(['library1']);
  });
});
