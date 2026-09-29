import { afterEach, expect, test } from 'bun:test';
import type { BrowseResponse } from '../../../../../src/schemas/browse';
import { browseApi } from '../../../api/browse';
import type { Invoke } from '../../../api/transport';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen, waitFor, within } =
  await import('@testing-library/react');
const { FolderBrowser } = await import('../folder_browser');
const { FolderBrowserPresenter } = await import('../folder_browser_presenter');
const { FolderBrowserStore } = await import('../folder_browser_store');

restoreApiAfterTests();
const bridge = Object.getOwnPropertyDescriptor(globalThis, '__TAURI__');
const userAgent = navigator.userAgent;

afterEach(() => {
  cleanup();
  if (bridge == null) Reflect.deleteProperty(globalThis, '__TAURI__');
  else Object.defineProperty(globalThis, '__TAURI__', bridge);
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
});

function shell(invoke: Invoke): void {
  Object.defineProperty(globalThis, '__TAURI__', {
    value: { core: { invoke } },
    configurable: true,
  });
}

function listing(path: string): BrowseResponse {
  return {
    path,
    parent: '/',
    directories: [{ name: 'Bin', path: `${path}/Bin` }],
    writable: false,
  };
}

function browser(): {
  store: InstanceType<typeof FolderBrowserStore>;
  presenter: InstanceType<typeof FolderBrowserPresenter>;
  paths: string[];
} {
  const store = new FolderBrowserStore();
  const presenter = new FolderBrowserPresenter(store);
  const paths: string[] = [];
  render(
    <FolderBrowser
      store={store}
      presenter={presenter}
      label="Library root path"
      canCreate
      onPathChange={(path) => paths.push(path)}
    />,
  );
  return { store, presenter, paths };
}

test('desktop initialization leaves selection empty until the native button is pressed', async () => {
  const commands: string[] = [];
  const browsed: (string | undefined)[] = [];
  shell(async (command) => {
    commands.push(command);
    return { kind: 'picked', path: '/pictures' };
  });
  browseApi.get = async (path) => {
    browsed.push(path);
    return listing(path ?? '/home/reader');
  };
  const { presenter, paths, store } = browser();

  await act(async () => {
    await presenter.open();
    await presenter.open('/');
  });

  const group = screen.getByRole('group', { name: 'Library root path' });
  expect(within(group).getByRole('button', { name: 'Choose folder' })).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Open parent folder' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Create folder' })).toBeNull();
  expect(commands).toEqual([]);
  expect(browsed).toEqual([]);
  expect(paths).toEqual(['']);
  expect(store.listing).toBeNull();
});

test.each(['/pictures/Autumn trip', 'C:\\Users\\Reader\\Autumn trip'])(
  'native selection displays and reports its exact path with folder metadata: %s',
  async (path) => {
    const commands: string[] = [];
    const browsed: (string | undefined)[] = [];
    shell(async (command) => {
      commands.push(command);
      return { kind: 'picked', path };
    });
    browseApi.get = async (asked) => {
      browsed.push(asked);
      return listing(path);
    };
    const { paths, store } = browser();

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

    await waitFor(() => expect(store.loading).toBe(false));
    expect(
      within(screen.getByRole('group', { name: 'Library root path' })).getByText(path),
    ).toBeTruthy();
    expect(paths).toEqual(['', path]);
    expect(store.listing).toEqual(listing(path));
    expect(commands).toEqual(['pick_export_folder']);
    expect(browsed).toEqual([path]);
  },
);

test('dismissing the native picker preserves the selected path and metadata', async () => {
  let picks = 0;
  shell(async () =>
    ++picks === 1 ? { kind: 'picked', path: '/pictures' } : { kind: 'dismissed' },
  );
  browseApi.get = async () => listing('/pictures');
  const { paths, store } = browser();
  const button = screen.getByRole('button', { name: 'Choose folder' });
  fireEvent.click(button);
  await waitFor(() => expect(store.loading).toBe(false));

  fireEvent.click(button);

  await waitFor(() => expect(store.loading).toBe(false));
  expect(screen.getByText('/pictures')).toBeTruthy();
  expect(store.listing).toEqual(listing('/pictures'));
  expect(paths).toEqual(['', '/pictures']);
});

test.each([42, ''])(
  'a malformed native path (%s) says why and allows another selection',
  async (invalidPath) => {
    let picks = 0;
    shell(async () =>
      ++picks === 1 ? { kind: 'picked', path: invalidPath } : { kind: 'picked', path: '/pictures' },
    );
    browseApi.get = async () => listing('/pictures');
    const { paths, store } = browser();
    const button = screen.getByRole('button', { name: 'Choose folder' });

    fireEvent.click(button);

    expect(await screen.findByText("We couldn't choose a folder. Try again.")).toBeTruthy();
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(paths).toEqual(['']);
    fireEvent.click(button);
    await waitFor(() => expect(store.loading).toBe(false));
    expect(screen.queryByText("We couldn't choose a folder. Try again.")).toBeNull();
    expect(screen.getByText('/pictures')).toBeTruthy();
    expect(paths).toEqual(['', '/pictures']);
  },
);

test('a metadata failure leaves the native selection visible and says why', async () => {
  shell(async () => ({ kind: 'picked', path: '/pictures' }));
  browseApi.get = async () => {
    throw new Error('Drive disconnected');
  };
  const { paths, store } = browser();

  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

  expect(await screen.findByText('Drive disconnected')).toBeTruthy();
  expect(screen.getByText('/pictures')).toBeTruthy();
  expect(paths).toEqual(['', '/pictures']);
  expect(store.loading).toBe(false);
  expect(store.listing).toBeNull();
});

test('a native request in flight disables the button and prevents duplicate picks', async () => {
  let finish: (value: unknown) => void = () => {};
  let picks = 0;
  shell(() => {
    picks++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const { store } = browser();
  const button = screen.getByRole('button', { name: 'Choose folder' });

  fireEvent.click(button);
  fireEvent.click(button);

  expect(button.hasAttribute('disabled')).toBe(true);
  expect(picks).toBe(1);
  await act(async () => {
    finish({ kind: 'dismissed' });
  });
  expect(store.loading).toBe(false);
  expect(button.hasAttribute('disabled')).toBe(false);
});

test('a fresh browser clears selection and ignores a previous browser’s pending native answer', async () => {
  let picks = 0;
  let finish: (value: unknown) => void = () => {};
  shell(() => {
    if (++picks === 1) return Promise.resolve({ kind: 'picked', path: '/pictures' });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  browseApi.get = async (path) => listing(path ?? '/home/reader');
  const paths: string[] = [];
  const store = new FolderBrowserStore();
  const presenter = new FolderBrowserPresenter(store);
  const { rerender } = render(
    <FolderBrowser
      store={store}
      presenter={presenter}
      label="Library root path"
      onPathChange={(path) => paths.push(path)}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  await waitFor(() => expect(store.loading).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

  const fresh = new FolderBrowserStore();
  rerender(
    <FolderBrowser
      store={fresh}
      presenter={new FolderBrowserPresenter(fresh)}
      label="Library root path"
      onPathChange={(path) => paths.push(path)}
    />,
  );
  await act(async () => {
    finish({ kind: 'picked', path: '/old-selection' });
  });

  expect(paths).toEqual(['', '/pictures', '']);
  expect(screen.queryByText('/pictures')).toBeNull();
  expect(screen.queryByText('/old-selection')).toBeNull();
  expect(screen.getByRole('button', { name: 'Choose folder' }).hasAttribute('disabled')).toBe(
    false,
  );
});

test.each(['web', 'Android'])(
  '%s opens its tree in a dialog and commits only the chosen folder',
  async (platform) => {
    if (platform === 'Android') {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14)',
        configurable: true,
      });
      shell(async () => {
        throw new Error('Native picker must not run');
      });
    }
    browseApi.get = async (path) => listing(path ?? '/home/reader');
    const { paths, presenter, store } = browser();

    await act(async () => {
      await presenter.open();
    });

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(paths).toEqual(['']);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    });
    const dialog = screen.getByRole('dialog', { name: 'Choose folder' });
    const input = within(dialog).getByRole('textbox', { name: 'Library root path' });
    expect(input.getAttribute('value')).toBe('/home/reader');
    expect(within(dialog).getByRole('button', { name: 'Create folder' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bin' }));
    await waitFor(() => expect(input.getAttribute('value')).toBe('/home/reader/Bin'));
    fireEvent.change(input, { target: { value: '/elsewhere' } });
    expect(paths).toEqual(['']);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder' }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('/elsewhere')).toBeTruthy();
    expect(store.listing).toEqual(listing('/elsewhere'));
    expect(paths).toEqual(['', '/elsewhere']);
  },
);

test('cancelled tree browsing preserves the chosen folder and its metadata', async () => {
  browseApi.get = async (path) => listing(path ?? '/home/reader');
  const { paths, store } = browser();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  });
  let dialog = screen.getByRole('dialog', { name: 'Choose folder' });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder' }));
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  });
  dialog = screen.getByRole('dialog', { name: 'Choose folder' });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Bin' }));
  });
  expect(store.listing).toEqual(listing('/home/reader'));
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  });

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('/home/reader')).toBeTruthy();
  expect(store.listing).toEqual(listing('/home/reader'));
  expect(paths).toEqual(['', '/home/reader']);
});

test('cancelling a typed folder while it is being checked ignores its late reply', async () => {
  let finish: (value: BrowseResponse) => void = () => {};
  browseApi.get = (path) =>
    path === '/delayed'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(listing(path ?? '/home/reader'));
  const { paths, store } = browser();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Choose folder' });
  fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '/delayed' } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder' }));
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await act(async () => {
    finish(listing('/delayed'));
  });

  expect(screen.queryByRole('dialog') == null).toBe(true);
  expect(store.selectedPath).toBe('');
  expect(paths).toEqual(['']);
});

test('choosing the same native folder again reports both confirmations', async () => {
  shell(async () => ({ kind: 'picked', path: '/pictures' }));
  browseApi.get = async () => listing('/pictures');
  const { paths } = browser();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  });
  expect(paths).toEqual(['', '/pictures', '/pictures']);
});

test('confirming a listed folder preserves whitespace in its name', async () => {
  const path = '/fixture/Trip ';
  browseApi.get = async (asked) => listing(asked ?? path);
  const { paths, store } = browser();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Choose folder' });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder' }));
  });

  expect(store.selectedPath).toBe(path);
  expect(paths).toEqual(['', path]);
});

test('confirmation locks tree controls and releases them after a refused path', async () => {
  let refuse: (error: Error) => void = () => {};
  browseApi.get = (path) =>
    path === '/first'
      ? new Promise((_resolve, reject) => {
          refuse = reject;
        })
      : Promise.resolve(listing(path ?? '/home/reader'));
  const { paths } = browser();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  });
  const dialog = screen.getByRole('dialog', { name: 'Choose folder' });
  const input = within(dialog).getByRole('textbox');
  fireEvent.change(input, { target: { value: '/first' } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder' }));
  });
  expect(input.matches(':disabled')).toBe(true);
  expect(within(dialog).getByRole('button', { name: 'Bin' }).matches(':disabled')).toBe(true);
  expect(within(dialog).getByRole('button', { name: 'Cancel' }).matches(':disabled')).toBe(false);
  await act(async () => {
    refuse(new Error('Drive disconnected'));
  });

  expect(input.matches(':disabled')).toBe(false);
  expect(within(dialog).getByText('Drive disconnected')).toBeTruthy();
  expect(paths).toEqual(['']);
  fireEvent.change(input, { target: { value: '/second' } });
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose folder' }));
  });
  expect(paths).toEqual(['', '/second']);
});
