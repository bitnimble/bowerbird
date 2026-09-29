import { afterEach, beforeEach, expect, test } from 'bun:test';
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
beforeEach(() => {
  librariesApi.list = () => Promise.resolve([]);
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
  expect(screen.getByText('12 photos').textContent).toBe('12 photos');
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Trip' }));
  });
  await press('Next');
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

  expect(screen.getByRole('radio', { name: 'Trip' }).matches(':checked')).toBe(false);
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
    const requests: AddReplicaRequest[] = [];
    replicationApi.addReplica = (request) => {
      requests.push(request);
      return Promise.resolve({ library_id: 'library1', peer_id: 'peer000000000001', applied: 0 });
    };
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
    await press('Choose folder');
    const picker = within(screen.getByRole('dialog', { name: 'Choose folder' }));
    await act(async () => {
      fireEvent.change(picker.getByRole('textbox', { name: 'Library root' }), {
        target: { value: '/fixture/trip' },
      });
      fireEvent.click(picker.getByRole('button', { name: 'Choose folder' }));
    });
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
