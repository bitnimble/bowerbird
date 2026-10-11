import { afterEach, beforeEach, expect, test } from 'bun:test';
import { DEFAULT_LIBRARY_SETTINGS, type Library } from '../../../../../src/schemas/libraries';
import { type AddReplicaRequest } from '../../../../../src/schemas/replication';
import { blobsApi } from '../../../api/blobs';
import { browseApi } from '../../../api/browse';
import { librariesApi } from '../../../api/libraries';
import { replicationApi } from '../../../api/replication';
import { registerDom } from '../../../test_dom';
import { restoreApiAfterTests } from '../../../test_api';

registerDom();
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { StoresProvider } = await import('../../../app/stores_context');
const { AddReplicaDialog } = await import('../add_replica_dialog');

restoreApiAfterTests();
afterEach(cleanup);

let here: string[] = [];

function libraryHere(id: string): Library {
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
    auto_stack_similarity: 0.78,
    auto_stack_window_seconds: 60,
    last_synced_at: null,
    photo_count: 0,
    missing_photo_count: 0,
    unavailable_photo_count: 0,
    rendered_photo_count: 0,
  };
}

/** `fail` gives a request's error, and `committed` whether its library still landed here. */
function recordAdds(
  fail: (request: AddReplicaRequest) => { error: Error; committed: boolean } | null = () => null,
): AddReplicaRequest[] {
  const requests: AddReplicaRequest[] = [];
  replicationApi.addReplica = (request) => {
    requests.push(request);
    const failure = fail(request);
    if (failure == null || failure.committed) here.push(request.library_id);
    if (failure != null) return Promise.reject(failure.error);
    return Promise.resolve({
      library_id: request.library_id,
      peer_id: 'peer000000000001',
      applied: 0,
    });
  };
  return requests;
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
  librariesApi.list = () => Promise.resolve(here.map(libraryHere));
  librariesApi.getDefaults = () => Promise.resolve(DEFAULT_LIBRARY_SETTINGS);
  blobsApi.listTransfers = () => Promise.resolve([]);
  browseApi.get = (path = '/') => Promise.resolve({ path, parent: null, directories: [] });
  replicationApi.listPeers = () =>
    Promise.resolve({ peers: [], sync_originals: true, auto_transfer_originals: true });
  replicationApi.browseRemote = () =>
    Promise.resolve({
      peer_id: 'peer000000000001',
      name: 'Desktop',
      address: 'http://desktop:5173',
      clock_ms: Date.now(),
      clock_skew_ms: 0,
      libraries: [
        { id: 'library1', name: 'Trip', photo_count: 12, read_only: false, replicating: true },
      ],
    });
});

async function press(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

async function chooseLibrary(): Promise<void> {
  const field = screen.getByRole('textbox', { name: 'Device address' });
  await act(async () => {
    fireEvent.change(field, { target: { value: 'desktop:5173' } });
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Enter' });
  });
  screen.getByText('12 photos');
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Trip' }));
  });
  await press('Next');
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

test('Enter browses the trimmed address once, and not at all while it is blank', async () => {
  const asked: string[] = [];
  const answer = Promise.withResolvers<Awaited<ReturnType<typeof replicationApi.browseRemote>>>();
  replicationApi.browseRemote = (address) => {
    asked.push(address);
    return answer.promise;
  };
  render(
    <StoresProvider>
      <AddReplicaDialog open onOpenChange={() => {}} />
    </StoresProvider>,
  );
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
  render(
    <StoresProvider>
      <AddReplicaDialog open onOpenChange={() => {}} />
    </StoresProvider>,
  );
  await chooseLibrary();
  await press('Back');
  await press('Back');
  await press('Next');

  expect(screen.getByRole('checkbox', { name: 'Trip' }).matches(':checked')).toBe(false);
  expect(screen.getByRole('button', { name: 'Next' }).matches(':disabled')).toBe(true);
});

test('automatic original transfers start enabled and reset when connect reopens', async () => {
  const dialog = (open: boolean): JSX.Element => (
    <StoresProvider>
      <AddReplicaDialog open={open} onOpenChange={() => {}} />
    </StoresProvider>
  );
  const view = render(dialog(true));
  await chooseLibrary();

  const option = screen.getByRole('checkbox', { name: 'Automatically send and fetch originals' });
  expect(option.matches(':checked')).toBe(true);
  await act(async () => {
    fireEvent.click(option);
  });
  expect(option.matches(':checked')).toBe(false);

  view.rerender(dialog(false));
  view.rerender(dialog(true));
  await chooseLibrary();
  expect(
    screen
      .getByRole('checkbox', { name: 'Automatically send and fetch originals' })
      .matches(':checked'),
  ).toBe(true);
  expect(screen.getByRole('combobox', { name: 'Denoiser' }).textContent).toContain('Fast (GALOSH)');
});

test.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
] as const)(
  'connect submits keep originals %s and automatic transfers %s independently',
  async (keepOriginals, autoTransfer) => {
    const requests = recordAdds();
    render(
      <StoresProvider>
        <AddReplicaDialog open onOpenChange={() => {}} />
      </StoresProvider>,
    );
    await chooseLibrary();

    if (!keepOriginals)
      await act(async () => {
        fireEvent.click(screen.getByRole('checkbox', { name: 'Keep originals on this device' }));
      });
    if (!autoTransfer)
      await act(async () => {
        fireEvent.click(
          screen.getByRole('checkbox', { name: 'Automatically send and fetch originals' }),
        );
      });
    await chooseFolder('/fixture/trip');
    await press('Add "Trip"');

    expect(requests).toEqual([
      {
        address: 'http://desktop:5173',
        library_id: 'library1',
        root_path: '/fixture/trip',
        sync_originals: keepOriginals,
        auto_transfer_originals: autoTransfer,
        denoiser: 'galosh',
      },
    ]);
  },
);

test('a read-only library can be picked, and is added read-only without originals', async () => {
  replicationApi.browseRemote = () =>
    Promise.resolve({
      peer_id: 'peer000000000001',
      name: 'Desktop',
      address: 'http://desktop:5173',
      clock_ms: Date.now(),
      clock_skew_ms: 0,
      libraries: [
        { id: 'library1', name: 'Archive', photo_count: 3, read_only: true, replicating: false },
      ],
    });
  const requests = recordAdds();
  render(
    <StoresProvider>
      <AddReplicaDialog open onOpenChange={() => {}} />
    </StoresProvider>,
  );
  const field = screen.getByRole('textbox', { name: 'Device address' });
  await act(async () => {
    fireEvent.change(field, { target: { value: 'desktop:5173' } });
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Enter' });
  });
  screen.getByText('3 photos · read-only');
  const option = screen.getByRole('checkbox', { name: 'Archive, read-only' });
  expect(option.matches(':disabled')).toBe(false);
  await act(async () => {
    fireEvent.click(option);
  });
  await press('Next');

  expect(screen.queryByRole('checkbox', { name: 'Keep originals on this device' })).toBeNull();
  expect(
    screen.queryByRole('checkbox', { name: 'Automatically send and fetch originals' }),
  ).toBeNull();
  screen.getByText('Originals stay on the other device.');
  await chooseFolder('/fixture/archive');
  await press('Add "Archive"');

  expect(requests).toEqual([
    {
      address: 'http://desktop:5173',
      library_id: 'library1',
      root_path: '/fixture/archive',
      sync_originals: false,
      auto_transfer_originals: false,
      denoiser: 'galosh',
    },
  ]);
});

async function chooseTwoLibraries(): Promise<void> {
  replicationApi.browseRemote = () =>
    Promise.resolve({
      peer_id: 'peer000000000001',
      name: 'Desktop',
      address: 'http://desktop:5173',
      clock_ms: Date.now(),
      clock_skew_ms: 0,
      libraries: [
        { id: 'library1', name: 'Trip', photo_count: 12, read_only: false, replicating: true },
        { id: 'library2', name: 'Archive', photo_count: 3, read_only: true, replicating: false },
      ],
    });
  const field = screen.getByRole('textbox', { name: 'Device address' });
  await act(async () => {
    fireEvent.change(field, { target: { value: 'desktop:5173' } });
  });
  await act(async () => {
    fireEvent.keyDown(field, { key: 'Enter' });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Archive, read-only' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Trip' }));
  });
  await press('Next');
}

test('several libraries each get a folder and are added in the order listed', async () => {
  const requests = recordAdds();
  let closed = false;
  render(
    <StoresProvider>
      <AddReplicaDialog open onOpenChange={(open) => (closed = !open)} />
    </StoresProvider>,
  );
  await chooseTwoLibraries();

  screen.getByText('Folder for "Trip"');
  expect(screen.getByRole('button', { name: 'Next' }).matches(':disabled')).toBe(true);
  expect(screen.queryByRole('combobox', { name: 'Denoiser' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Keep originals on this device' })).toBeNull();
  await chooseFolder('/fixture/trip');
  await press('Next');
  screen.getByText('Folder for "Archive"');
  expect(screen.getByRole('button', { name: 'Add 2 libraries' }).matches(':disabled')).toBe(true);
  await press('Back');
  screen.getByText('Folder for "Trip"');
  screen.getByText('/fixture/trip');
  await press('Next');
  await chooseFolder('/fixture/archive');
  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep originals on this device' }));
  });
  await press('Add 2 libraries');

  expect(requests).toEqual([
    {
      address: 'http://desktop:5173',
      library_id: 'library1',
      root_path: '/fixture/trip',
      sync_originals: false,
      auto_transfer_originals: true,
      denoiser: 'galosh',
    },
    {
      address: 'http://desktop:5173',
      library_id: 'library2',
      root_path: '/fixture/archive',
      sync_originals: false,
      auto_transfer_originals: false,
      denoiser: 'galosh',
    },
  ]);
  expect(closed).toBe(true);
});

async function addBothFailingOnArchive(committed: boolean): Promise<{
  requests: AddReplicaRequest[];
  closed: () => boolean;
}> {
  const requests = recordAdds((request) =>
    request.library_id === 'library2' && requests.length === 2
      ? { error: new Error('Unable to connect'), committed }
      : null,
  );
  let closed = false;
  render(
    <StoresProvider>
      <AddReplicaDialog open onOpenChange={(open) => (closed = !open)} />
    </StoresProvider>,
  );
  await chooseTwoLibraries();
  await chooseFolder('/fixture/trip');
  await press('Next');
  await chooseFolder('/fixture/archive');
  await press('Add 2 libraries');
  return { requests, closed: () => closed };
}

test('a failed add keeps only the libraries not yet on this device', async () => {
  const { requests, closed } = await addBothFailingOnArchive(false);

  expect(closed()).toBe(false);
  screen.getByText(/Unable to connect/);
  screen.getByText('Folder on this device');
  screen.getByText('/fixture/archive');
  await press('Add "Archive"');
  expect(requests.map((request) => request.library_id)).toEqual([
    'library1',
    'library2',
    'library2',
  ]);
  expect(requests[2]).toEqual({
    address: 'http://desktop:5173',
    library_id: 'library2',
    root_path: '/fixture/archive',
    sync_originals: false,
    auto_transfer_originals: false,
    denoiser: 'galosh',
  });
  expect(closed()).toBe(true);
});

test('an add that failed after reaching this device is not offered again', async () => {
  const { requests, closed } = await addBothFailingOnArchive(true);

  expect(requests.map((request) => request.library_id)).toEqual(['library1', 'library2']);
  expect(closed()).toBe(true);
});

test('a library already on this device cannot be picked', async () => {
  await addBothFailingOnArchive(false);
  await press('Back');

  const trip = screen.getByRole('checkbox', { name: 'Trip' });
  expect(trip.matches(':disabled')).toBe(true);
  expect(trip.matches(':checked')).toBe(false);
  screen.getByText('Already on this device');
  expect(screen.getByRole('checkbox', { name: 'Archive, read-only' }).matches(':checked')).toBe(
    true,
  );
});

test('the mobile app adds several libraries from 1 screen without folders', async () => {
  await asThinShell(async () => {
    const requests = recordAdds();
    render(
      <StoresProvider>
        <AddReplicaDialog open onOpenChange={() => {}} />
      </StoresProvider>,
    );
    await chooseTwoLibraries();

    expect(screen.queryByRole('button', { name: 'Choose folder' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Keep originals on this device' })).toBeNull();
    await press('Add 2 libraries');
    expect(requests).toEqual([
      {
        address: 'http://desktop:5173',
        library_id: 'library1',
        sync_originals: false,
        auto_transfer_originals: false,
        denoiser: 'galosh',
      },
      {
        address: 'http://desktop:5173',
        library_id: 'library2',
        sync_originals: false,
        auto_transfer_originals: false,
        denoiser: 'galosh',
      },
    ]);
  });
});

test('the mobile app leaves the folder to its server and asks nothing about originals', async () => {
  await asThinShell(async () => {
    const requests = recordAdds();
    render(
      <StoresProvider>
        <AddReplicaDialog open onOpenChange={() => {}} />
      </StoresProvider>,
    );
    await chooseLibrary();

    expect(screen.queryByRole('button', { name: 'Choose folder' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Keep originals on this device' })).toBeNull();
    expect(
      screen.queryByRole('checkbox', { name: 'Automatically send and fetch originals' }),
    ).toBeNull();
    await press('Add "Trip"');
    expect(requests).toEqual([
      {
        address: 'http://desktop:5173',
        library_id: 'library1',
        sync_originals: false,
        auto_transfer_originals: false,
        denoiser: 'galosh',
      },
    ]);
  });
});
