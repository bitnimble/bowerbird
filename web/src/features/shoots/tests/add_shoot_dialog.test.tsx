import { afterEach, expect, test } from 'bun:test';
import { type PhotoListResponse } from '../../../../../src/schemas/photos';
import { type CreateShootRequest, type Shoot } from '../../../../../src/schemas/shoots';
import { librariesApi } from '../../../api/libraries';
import { photosApi } from '../../../api/photos';
import { shootsApi } from '../../../api/shoots';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { AddShootDialog } = await import('../add_shoot_dialog');
const { StoresProvider } = await import('../../../app/stores_context');

restoreApiAfterTests();
afterEach(cleanup);

const shoot = (id: string, folder_path: string, name: string, parent_id: string | null): Shoot =>
  ({ id, library_id: 'lib', folder_path, name, parent_id, is_hidden: false }) as Shoot;

const created: CreateShootRequest[] = [];
shootsApi.list = (): Promise<Shoot[]> =>
  Promise.resolve([
    shoot('trip', '2024/Trip', 'Trip', null),
    shoot('day', '2024/Trip/Day 1', 'Day 1', 'trip'),
    shoot('dawn', 'Dawn', 'Dawn', null),
  ]);
shootsApi.create = (body): Promise<Shoot> => {
  created.push(body);
  return Promise.resolve(shoot('new', '', body.name, null));
};
librariesApi.folders = (): ReturnType<typeof librariesApi.folders> => Promise.resolve([]);
photosApi.listLibrary = (): Promise<PhotoListResponse> =>
  Promise.resolve({ photos: [], photo_total: 0, offset: 0, limit: 1, ordering: 'taken_asc' });

async function openDialog(parentPath: string): Promise<void> {
  created.length = 0;
  render(
    <MemoryRouter>
      <StoresProvider>
        <AddShootDialog libraryId="lib" parentPath={parentPath} open onOpenChange={() => {}} />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
}

const parentPicker = (): HTMLElement => screen.getByRole('combobox', { name: 'Parent shoot' });

async function create(name: string): Promise<void> {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: name } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Create shoot' }));
  });
}

test('the parent offers every shoot, nested, and the new folder goes inside the one chosen', async () => {
  await openDialog('');
  expect(parentPicker().textContent).toContain('None');
  fireEvent.click(parentPicker());
  const options = screen.getAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual(['None', 'Dawn', 'Trip', 'Day 1']);
  expect(options[2]!.getAttribute('style')).toContain('9px');
  expect(options[3]!.getAttribute('style')).toContain('25px');
  // Base UI commits only a highlighted item, which a real pointer does by hovering.
  await act(async () => {
    fireEvent.focus(options[3]!);
  });
  await act(async () => {
    fireEvent.click(options[3]!);
  });
  await create('Sunrise');
  expect(created.map((c) => c.parent_path)).toEqual(['2024/Trip/Day 1']);
  expect(screen.getByText('2024/Trip/Day 1/Sunrise').tagName).toBe('CODE');
});

test('without a parent the shoot goes at the library root', async () => {
  await openDialog('');
  await create('Low tide');
  expect(created.map((c) => c.parent_path)).toEqual(['']);
});

test('opened from a shoot, the parent starts on that shoot', async () => {
  await openDialog('2024/Trip');
  expect(parentPicker().textContent).toContain('Trip');
  fireEvent.click(parentPicker());
  expect(screen.getAllByRole('option')).toHaveLength(4);
  await create('Day 2');
  expect(created.map((c) => c.parent_path)).toEqual(['2024/Trip']);
});

test('opened from a folder that is no shoot, the parent starts on that folder', async () => {
  await openDialog('Scans');
  expect(parentPicker().textContent).toContain('Scans');
  await create('Negatives');
  expect(created.map((c) => c.parent_path)).toEqual(['Scans']);
});
