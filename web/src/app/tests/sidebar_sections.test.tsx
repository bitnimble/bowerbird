// Opening and closing the sidebar's sections, which is the wiring between a chevron,
// the remembered set and the rows that appear - the half `sidebar_store.test.ts`
// cannot see, none of it being the store's own arithmetic.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Album } from '../../../../src/schemas/albums';
import { type Library } from '../../../../src/schemas/libraries';
import { type Shoot } from '../../../../src/schemas/shoots';
import { albumsApi } from '../../api/albums';
import { shootsApi } from '../../api/shoots';
import { restoreApiAfterTests } from '../../test_api';
import { registerDom } from '../../test_dom';
import { MemoryStorage } from '../../test_storage';

registerDom();
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { Sidebar } = await import('../app');
const { StoresProvider, useLibrariesStore } = await import('../stores_context');

restoreApiAfterTests();
afterEach(cleanup);
// Which sections are open is remembered, and a new presenter reads it back as it is
// built - so a test that closes something would decide where the next one starts.
beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

const LIBRARY = { id: 'lib', name: 'Reef', root_path: '/photos/reef', photo_count: 12 } as Library;

function shoot(id: string, name: string, parent_id: string | null): Shoot {
  return {
    id,
    parent_id,
    library_id: 'lib',
    folder_path: name,
    name,
    description: null,
    banner_photo_id: null,
    ordering: 'taken_asc',
    photo_count: 3,
    is_hidden: false,
    hidden_directly: false,
  };
}

const SHOOTS = [shoot('dawn', 'Dawn', null), shoot('gulls', 'Gulls', 'dawn')];
const ALBUMS: Album[] = [{ id: 'best', name: 'Best of', ordering: 'taken_asc', banner_photo_id: null, photo_count: 4 }];

shootsApi.list = (): Promise<Shoot[]> => Promise.resolve(SHOOTS);
albumsApi.list = (): Promise<Album[]> => Promise.resolve(ALBUMS);

// The stores belong to the provider, so the one library these rows are of is
// written from inside it rather than handed in.
function Seed({ library }: { library: Library }): null {
  const libraries = useLibrariesStore();
  useEffect(() => {
    runInAction(() => (libraries.libraries = [library]));
  }, [libraries, library]);
  return null;
}

// Every section reads when it opens, so both the first render and each click
// settle before anything is asserted on.
async function open(library = LIBRARY): Promise<void> {
  render(
    <MemoryRouter>
      <StoresProvider>
        <Seed library={library} />
        <Sidebar onCollapse={() => {}} />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
}

async function press(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

// What the sidebar did before any of this existed, which is what it still has to do
// for a reader who never touches a chevron.
test('a library starts open, with its count, and everything under it starts shut', async () => {
  await open();
  expect(screen.getByRole('link', { name: 'Photos' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Shoots' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Bin' })).toBeTruthy();
  expect(screen.getByText('12')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Dawn, 3 photos' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Best of, 4 photos' })).toBeNull();
});

// Inside the link rather than beside it, so the row lights up as one thing under the
// pointer - and named, because two adjacent spans are read as one run-on word, which
// is why every row above is asked for by the whole line rather than by its name.
test('a count belongs to the row it counts, and is read as part of it', async () => {
  await open();
  const library = screen.getByRole('link', { name: 'Reef, 12 photos' });
  expect(within(library).getByText('12')).toBeTruthy();
});

test('a read-only library wears a badge, and is read as read-only', async () => {
  await open({ ...LIBRARY, read_only: true });
  const library = screen.getByRole('link', { name: 'Reef, read-only, 12 photos' });
  expect(within(library).getByTitle('Read-only')).toBeTruthy();
});

test('a writable library wears no badge', async () => {
  await open();
  expect(within(screen.getByRole('link', { name: 'Reef, 12 photos' })).queryByTitle('Read-only')).toBeNull();
});

test('closing a library takes its pages with it and leaves the library', async () => {
  await open();
  await press('Collapse Reef');

  expect(screen.queryByRole('link', { name: 'Photos' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Shoots' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Reef, 12 photos' })).toBeTruthy();

  await press('Expand Reef');
  expect(screen.getByRole('link', { name: 'Photos' })).toBeTruthy();
});

test("opening Shoots reads the library's shoots, nested under their parent", async () => {
  await open();
  await press('Expand Shoots');

  expect(screen.getByRole('link', { name: 'Dawn, 3 photos' })).toBeTruthy();
  // A shoot with something under it starts shut, like every other section.
  expect(screen.queryByRole('link', { name: 'Gulls, 3 photos' })).toBeNull();

  await press('Expand Dawn');
  expect(screen.getByRole('link', { name: 'Gulls, 3 photos' })).toBeTruthy();

  // And closing the library above them takes the whole subtree, opened or not.
  await press('Collapse Reef');
  expect(screen.queryByRole('link', { name: 'Gulls, 3 photos' })).toBeNull();
});

test('opening Albums lists the albums', async () => {
  await open();
  await press('Expand Albums');
  expect(screen.getByRole('link', { name: 'Best of, 4 photos' })).toBeTruthy();

  await press('Collapse Albums');
  expect(screen.queryByRole('link', { name: 'Best of, 4 photos' })).toBeNull();
});
