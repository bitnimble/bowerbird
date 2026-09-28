// A name already in the picked folder is numbered rather than truncated, and it has to be
// numbered the way `src-tauri/src/export.rs` numbers the shell's - the rule is written twice
// because the two destinations are different APIs, so it is pinned in both places.
import { afterEach, expect, test } from 'bun:test';
import { ExportOptionsSchema } from '../../../../../src/schemas/export';
import { exportsApi } from '../../../api/exports';
import { registerDom } from '../../../test_dom';
import { restoreApiAfterTests } from '../../../test_api';

// For `window` alone: `chooseSink` reads the picker off it, and a stub assigned to a bare
// `globalThis.window` is not the object the module under test looks at.
registerDom();
const { chooseSink } = await import('../export_sink');

restoreApiAfterTests();
const bridge = Object.getOwnPropertyDescriptor(globalThis, '__TAURI__');
const browserPicker = Object.getOwnPropertyDescriptor(window, 'showDirectoryPicker');

afterEach(() => {
  if (bridge == null) Reflect.deleteProperty(globalThis, '__TAURI__');
  else Object.defineProperty(globalThis, '__TAURI__', bridge);
  if (browserPicker == null) Reflect.deleteProperty(window, 'showDirectoryPicker');
  else Object.defineProperty(window, 'showDirectoryPicker', browserPicker);
});

/** Just enough of the handle for the sink: names that exist, and what it was asked to create. */
function folder(holding: string[]): { handle: FileSystemDirectoryHandle; created: string[] } {
  const created: string[] = [];
  const written: string[] = [];
  const handle = {
    name: 'Exports',
    getFileHandle: (name: string, options?: { create?: boolean }) => {
      if (options?.create === true) {
        created.push(name);
        return Promise.resolve({
          createWritable: () =>
            Promise.resolve({
              write: (chunk: unknown) => {
                written.push(String(chunk));
                return Promise.resolve();
              },
              close: () => Promise.resolve(),
            }),
        });
      }
      if (holding.includes(name)) return Promise.resolve({});
      return Promise.reject(new DOMException('no such file', 'NotFoundError'));
    },
  } as unknown as FileSystemDirectoryHandle;
  return { handle, created };
}

/** The picker, standing in for Chromium's, plus a library that answers one named file. */
async function exportInto(
  holding: string[],
  filename: string | null,
): Promise<{ created: string[]; asked: { runId?: string }[]; save: (photoId: string) => Promise<string> }> {
  const { handle, created } = folder(holding);
  const asked: { runId?: string }[] = [];
  (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = () => Promise.resolve(handle);
  exportsApi.create = (body: { runId?: string }) => {
    asked.push(body);
    return Promise.resolve({ bytes: new Uint8Array([1]), mediaType: 'image/jpeg', filename });
  };

  const sink = await chooseSink(2);
  if (sink == null) throw new Error('the picker was meant to answer a directory');
  return { created, asked, save: (photoId) => sink.save(photoId, {} as never, 'run1') };
}

test('a name the folder already holds is numbered rather than truncated', async () => {
  const { created, save } = await exportInto(['DSC02981.jpg', 'DSC02981 (2).jpg'], 'DSC02981.jpg');
  await save('a');
  expect(created).toEqual(['DSC02981 (3).jpg']);
});

test('a free name is used as it stands, and the render is told which run it is for', async () => {
  const { created, asked, save } = await exportInto([], 'DSC02981.jpg');
  // The name it settled on, which is what the history is told the file landed under: a
  // handle can say which folder it is but never where that folder is.
  expect(await save('a')).toBe('Exports/DSC02981.jpg');
  expect(created).toEqual(['DSC02981.jpg']);
  // Carried into the render rather than reported after it: the history's row and its tile are
  // written there, and a render told of no run writes neither.
  expect(asked[0]?.runId).toBe('run1');
});

// The same two edge cases `export.rs` pins: the number goes on the end of a name that is all
// extension, rather than turning `.DS_Store` into ` (2).DS_Store`.
test('a name that is all extension still numbers on the end', async () => {
  const { created, save } = await exportInto(['.DS_Store', 'photo'], '.DS_Store');
  await save('a');
  expect(created).toEqual(['.DS_Store (2)']);

  const second = await exportInto(['photo'], 'photo');
  await second.save('a');
  expect(second.created).toEqual(['photo (2)']);
});

test('one file is a download rather than a folder to pick', async () => {
  let asked = false;
  (window as { showDirectoryPicker?: unknown }).showDirectoryPicker = () => {
    asked = true;
    return Promise.reject(new DOMException('dismissed', 'AbortError'));
  };
  expect(await chooseSink(1)).not.toBeNull();
  expect(asked).toBe(false);
});

// Refused rather than invented, so a file never lands under a name the reader cannot place.
test('a render the library did not name is refused', async () => {
  const { created, save } = await exportInto([], null);
  await expect(save('a')).rejects.toThrow(/has no filename/);
  expect(created).toEqual([]);
});

test.each([1, 2])('a native export of %s photos picks a folder and saves through the shell', async (count) => {
  const calls: { command: string; args: unknown }[] = [];
  const path = 'C:\\Users\\Reader\\Autumn trip';
  Object.defineProperty(globalThis, '__TAURI__', {
    value: {
      core: {
        invoke: async (command: string, args: unknown) => {
          calls.push({ command, args });
          return command === 'pick_export_folder' ? { kind: 'picked', path } : `${path}\\photo.jpg`;
        },
      },
    },
    configurable: true,
  });
  const options = ExportOptionsSchema.parse({});

  const sink = await chooseSink(count);
  expect(sink).not.toBeNull();
  expect(await sink?.save('photo1', options, 'run1')).toBe(`${path}\\photo.jpg`);
  expect(calls).toEqual([
    { command: 'pick_export_folder', args: {} },
    { command: 'export_to_folder', args: { folder: path, photoId: 'photo1', options, runId: 'run1' } },
  ]);
});

test.each(['dismissed', 'unsupported'])('the shell’s %s folder answer preserves export behavior', async (kind) => {
  Object.defineProperty(globalThis, '__TAURI__', {
    value: { core: { invoke: async () => ({ kind }) } },
    configurable: true,
  });

  const sink = await chooseSink(2);

  if (kind === 'dismissed') expect(sink).toBeNull();
  else expect(sink).not.toBeNull();
});
