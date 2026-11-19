import { afterEach, expect, test } from 'bun:test';
import { StrictMode } from 'react';
import type { BrowseResponse } from '../../../../../src/schemas/browse';
import {
  CreateLibraryRequestSchema,
  type CreateLibraryRequest,
  type Library,
} from '../../../../../src/schemas/libraries';
import { browseApi } from '../../../api/browse';
import { librariesApi } from '../../../api/libraries';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import('@testing-library/react');
const { AddLibraryDialog } = await import('../add_library_dialog');
const { StoresProvider } = await import('../../../app/stores_context');

restoreApiAfterTests();
const bridge = Object.getOwnPropertyDescriptor(globalThis, '__TAURI__');
afterEach(() => {
  cleanup();
  if (bridge == null) Reflect.deleteProperty(globalThis, '__TAURI__');
  else Object.defineProperty(globalThis, '__TAURI__', bridge);
});

const CAMERA = '/storage/emulated/0/DCIM';
const PHONE = CreateLibraryRequestSchema.parse({
  root_path: CAMERA,
  name: 'Phone',
  ordering: 'taken_desc',
  include_non_raw: true,
  rendition_source: 'embedded',
  render_skip_full: ['dust'],
  render_skip_max: ['dust'],
});

async function open(create: (body: CreateLibraryRequest) => Promise<Library>): Promise<boolean[]> {
  const changes: boolean[] = [];
  librariesApi.list = () => Promise.resolve([]);
  librariesApi.getDefaults = () =>
    Promise.resolve({} as Awaited<ReturnType<typeof librariesApi.getDefaults>>);
  librariesApi.create = create;
  render(
    <StoresProvider>
      <AddLibraryDialog open preset={PHONE} onOpenChange={(open) => changes.push(open)} />
    </StoresProvider>,
  );
  await act(async () => {});
  return changes;
}

async function add(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add library' }));
  });
}

test('a preset library shows its folder and name, and is created with every preset setting', async () => {
  const sent: CreateLibraryRequest[] = [];
  const changes = await open((body) => {
    sent.push(body);
    return Promise.resolve({ id: 'phone', root_path: body.root_path } as Library);
  });

  expect(screen.getByText(CAMERA)).toBeTruthy();
  expect(screen.queryByRole('textbox', { name: 'Library root' })).toBeNull();
  expect((screen.getByRole('textbox', { name: 'Library name' }) as HTMLInputElement).value).toBe(
    'Phone',
  );

  await add();

  expect(sent).toEqual([PHONE]);
  expect(changes).toEqual([false]);
});

test('a preset library that fails to create says why and stays open', async () => {
  const changes = await open(() => Promise.reject(new Error('The camera folder is gone.')));

  await add();

  expect(screen.getByText('The camera folder is gone.')).toBeTruthy();
  expect(changes).toEqual([]);
});

function listing(path: string): BrowseResponse {
  return { path, parent: '/', directories: [], writable: true };
}

async function start({
  get = async (path) => listing(path ?? '/pictures/Autumn trip'),
  strict = false,
}: { get?: typeof browseApi.get; strict?: boolean } = {}): Promise<boolean[]> {
  const changes: boolean[] = [];
  librariesApi.list = () => Promise.resolve([]);
  browseApi.get = get;
  const tree = (
    <StoresProvider>
      <AddLibraryDialog open onOpenChange={(open) => changes.push(open)} />
    </StoresProvider>
  );
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  await act(async () => {});
  return changes;
}

function nativePicker(invoke: () => Promise<unknown>): void {
  Object.defineProperty(globalThis, '__TAURI__', {
    value: { core: { invoke } },
    configurable: true,
  });
}

async function chooseInTree(path?: string): Promise<void> {
  const chooser = screen.getByRole('dialog', { name: 'Choose folder' });
  if (path != null) {
    fireEvent.change(within(chooser).getByRole('textbox'), { target: { value: path } });
  }
  await act(async () => {
    fireEvent.click(within(chooser).getByRole('button', { name: 'Choose folder' }));
  });
}

async function openTree(dialog: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder' }));
  });
}

function libraryName(dialog: HTMLElement): string {
  return (within(dialog).getByRole('textbox', { name: 'Library name' }) as HTMLInputElement).value;
}

test('the folder tree comes first, and the library settings only once it has an answer', async () => {
  await start();

  expect(screen.getByRole('dialog', { name: 'Choose folder' })).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Add library' })).toBeNull();

  await chooseInTree();

  expect(screen.queryByRole('dialog', { name: 'Choose folder' })).toBeNull();
  const dialog = screen.getByRole('dialog', { name: 'Add library' });
  expect(within(dialog).getByText('/pictures/Autumn trip')).toBeTruthy();
  expect(libraryName(dialog)).toBe('Autumn trip');
});

test('a later folder renames the library until a name is typed', async () => {
  await start();
  await chooseInTree();
  const dialog = screen.getByRole('dialog', { name: 'Add library' });

  await openTree(dialog);
  await chooseInTree('/pictures/Winter');
  expect(within(dialog).getByText('/pictures/Winter')).toBeTruthy();
  expect(libraryName(dialog)).toBe('Winter');

  fireEvent.change(within(dialog).getByRole('textbox', { name: 'Library name' }), {
    target: { value: 'Mine' },
  });
  await openTree(dialog);
  await chooseInTree('/pictures/Spring');
  expect(within(dialog).getByText('/pictures/Spring')).toBeTruthy();
  expect(libraryName(dialog)).toBe('Mine');
});

test('the finished formats start switched on', async () => {
  await start();
  await chooseInTree();

  const nonRaw = screen.getByRole('checkbox', {
    name: 'Import JPEG, PNG, HEIC, and AVIF too',
    hidden: true,
  }) as HTMLInputElement;
  expect(nonRaw.checked).toBe(true);
});

test('cancelling the first folder tree closes the whole flow', async () => {
  const changes = await start();

  const chooser = screen.getByRole('dialog', { name: 'Choose folder' });
  await act(async () => {
    fireEvent.click(within(chooser).getByRole('button', { name: 'Cancel' }));
  });

  expect(changes).toEqual([false]);
  expect(screen.queryByRole('dialog', { name: 'Add library' })).toBeNull();
});

test('a later folder tree cancelled keeps the settings and the chosen folder', async () => {
  const changes = await start();
  await chooseInTree();

  const dialog = screen.getByRole('dialog', { name: 'Add library' });
  await openTree(dialog);
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Choose folder' })).getByRole('button', {
        name: 'Cancel',
      }),
    );
  });

  expect(changes).toEqual([]);
  expect(screen.queryByRole('dialog', { name: 'Choose folder' })).toBeNull();
  const after = screen.getByRole('dialog', { name: 'Add library' });
  expect(after).toBe(dialog);
  expect(within(after).getByText('/pictures/Autumn trip')).toBeTruthy();
  expect(libraryName(after)).toBe('Autumn trip');
});

test('the native picker opens by itself and a pick moves on to the settings', async () => {
  nativePicker(async () => ({ kind: 'picked', path: '/pictures' }));
  await start();

  const dialog = await screen.findByRole('dialog', { name: 'Add library' });
  expect(within(dialog).getByText('/pictures')).toBeTruthy();
});

test('StrictMode asks the native picker once and waits for its answer', async () => {
  let picks = 0;
  let answer: (value: unknown) => void = () => {};
  nativePicker(() => {
    picks++;
    return new Promise((resolve) => {
      answer = resolve;
    });
  });
  const changes = await start({ strict: true });

  expect(picks).toBe(1);
  expect(changes).toEqual([]);
  expect(screen.queryByRole('dialog')).toBeNull();

  await act(async () => {
    answer({ kind: 'picked', path: '/pictures' });
  });

  const dialog = await screen.findByRole('dialog', { name: 'Add library' });
  expect(within(dialog).getByText('/pictures')).toBeTruthy();
  expect(changes).toEqual([]);
});

test('dismissing the native picker closes the whole flow', async () => {
  nativePicker(async () => ({ kind: 'dismissed' }));
  const changes = await start();

  await waitFor(() => expect(changes).toEqual([false]));
  expect(screen.queryByRole('dialog', { name: 'Add library' })).toBeNull();
});

test('a native picker that fails says why from the settings', async () => {
  nativePicker(async () => ({ kind: 'unsupported' }));
  await start();

  const dialog = await screen.findByRole('dialog', { name: 'Add library' });
  expect(within(dialog).getByText("We couldn't choose a folder. Try again.")).toBeTruthy();
  const confirm = within(dialog).getByRole('button', { name: 'Add library' });
  expect(confirm.hasAttribute('disabled')).toBe(true);
});

test('a folder the server cannot write in says so outside Advanced settings', async () => {
  await start({ get: async (path) => ({ ...listing(path ?? '/locked'), writable: false }) });
  await chooseInTree();

  const dialog = screen.getByRole('dialog', { name: 'Add library' });
  const hint = within(dialog).getByText(
    "Bowerbird can't write to this folder. Choose another folder.",
  );
  expect(hint.closest('details')).toBeNull();
  expect(within(dialog).queryByRole('textbox', { name: 'Bin folder name' })).toBeNull();
});

test('only name, sort, and bin folder name sit outside Advanced settings', async () => {
  await open(() => Promise.reject(new Error('unused')));

  const dialog = screen.getByRole('dialog', { name: 'Add library' });
  const advanced = within(dialog).getByText('Advanced settings').closest('details');
  expect(advanced?.open).toBe(false);
  for (const name of ['Library name', 'Bin folder name']) {
    expect(within(dialog).getByRole('textbox', { name }).closest('details')).toBeNull();
  }
  expect(within(dialog).getByRole('combobox', { name: 'Sort photos by' }).closest('details')).toBe(
    null,
  );
  expect(
    within(dialog).getByRole('combobox', { name: 'Denoiser', hidden: true }).closest('details'),
  ).toBe(advanced);
  const checkboxes = within(dialog).getAllByRole('checkbox', { hidden: true });
  expect(checkboxes.length).toBe(5);
  for (const checkbox of checkboxes) expect(checkbox.closest('details')).toBe(advanced);
});
