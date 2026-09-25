// What a read-only library's Shoots page offers: making a folder and renaming a shoot are still
// on the menus, greyed, and say why.
import { afterEach, expect, test } from 'bun:test';
import { PathSegment, route } from '../../../../../src/schemas/route';
import { type Library, type LibrarySettings } from '../../../../../src/schemas/libraries';
import { type PhotoListResponse } from '../../../../../src/schemas/photos';
import { type Shoot } from '../../../../../src/schemas/shoots';
import { librariesApi } from '../../../api/libraries';
import { photosApi } from '../../../api/photos';
import { shootsApi } from '../../../api/shoots';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter, Route, Routes } = await import('react-router-dom');
const { ShootsPage } = await import('../shoots_page');
const { StoresProvider } = await import('../../../app/stores_context');

restoreApiAfterTests();
afterEach(cleanup);

const DAWN: Shoot = {
  id: 'dawn',
  parent_id: null,
  library_id: 'lib',
  folder_path: 'Dawn',
  name: 'Dawn',
  description: null,
  banner_photo_id: null,
  ordering: 'taken_asc',
  photo_count: 3,
  is_hidden: false,
  hidden_directly: false,
};

async function openPage(readOnly: boolean): Promise<void> {
  librariesApi.list = (): Promise<Library[]> =>
    Promise.resolve([{ id: 'lib', name: 'Reef', root_path: '/photos/reef', read_only: readOnly } as Library]);
  librariesApi.getDefaults = (): Promise<LibrarySettings> => Promise.resolve({} as LibrarySettings);
  shootsApi.list = (): Promise<Shoot[]> => Promise.resolve([DAWN]);
  librariesApi.folders = (): Promise<string[]> => Promise.resolve(['Dawn']);
  photosApi.listLibrary = (): Promise<PhotoListResponse> =>
    Promise.resolve({ photos: [], photo_total: 0, offset: 0, limit: 1, ordering: 'taken_asc' });

  render(
    <MemoryRouter initialEntries={[route(PathSegment.libraries(), 'lib', PathSegment.shoots())]}>
      <StoresProvider>
        <Routes>
          <Route path={route(PathSegment.libraries(), PathSegment.param('libraryId'), PathSegment.shoots())} element={<ShootsPage />} />
        </Routes>
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
}

async function openMenu(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

function refusal(name: string): string | null {
  const item = screen.getByRole('menuitem', { name });
  return item.getAttribute('aria-disabled') === 'true' ? item.getAttribute('aria-description') : null;
}

test('a read-only library greys making a folder at the root', async () => {
  await openPage(true);
  await openMenu('Add to the library root');
  expect(refusal('Create shoot in subfolder')).toBe('Turn off read-only mode to use this action.');
});

test("a read-only library greys a shoot's rename and its new subfolder", async () => {
  await openPage(true);
  await openMenu('Actions for Dawn');
  expect(refusal('Rename')).toBe('Turn off read-only mode to use this action.');
  expect(refusal('Create shoot in subfolder')).toBe('Turn off read-only mode to use this action.');
});

test('a writable library offers both', async () => {
  await openPage(false);
  await openMenu('Actions for Dawn');
  expect(refusal('Rename')).toBeNull();
  expect(refusal('Create shoot in subfolder')).toBeNull();
});
