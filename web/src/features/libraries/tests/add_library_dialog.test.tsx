import { afterEach, expect, test } from 'bun:test';
import {
  CreateLibraryRequestSchema,
  type CreateLibraryRequest,
  type Library,
} from '../../../../../src/schemas/libraries';
import { librariesApi } from '../../../api/libraries';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { AddLibraryDialog } = await import('../add_library_dialog');
const { StoresProvider } = await import('../../../app/stores_context');

restoreApiAfterTests();
afterEach(cleanup);

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
