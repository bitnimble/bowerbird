// Filing a selection into a shoot or album that does not exist yet: the dialog makes it, the
// selection goes into it, and the grid stays where it is.
import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Album } from '../../../../../../src/schemas/albums';
import { type Library } from '../../../../../../src/schemas/libraries';
import { type PhotoListResponse, type PhotoSummary, type PhotoTarget } from '../../../../../../src/schemas/photos';
import { type Shoot } from '../../../../../../src/schemas/shoots';
import { albumsApi } from '../../../../api/albums';
import { librariesApi } from '../../../../api/libraries';
import { photosApi } from '../../../../api/photos';
import { shootsApi } from '../../../../api/shoots';
import { restoreApiAfterTests } from '../../../../test_api';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter, useLocation } = await import('react-router-dom');
const { BulkBar } = await import('../bulk_bar');
const { StoresProvider, useLibrariesStore, useListingStore, useMarksStore, useShootsStore } =
  await import('../../../../app/stores_context');
const { SelectionRanges } = await import('../../selection');

restoreApiAfterTests();
afterEach(cleanup);

const added: { kind: 'shoot' | 'album'; id: string; target: PhotoTarget }[] = [];
const created: unknown[] = [];

albumsApi.create = (body): Promise<Album> => {
  created.push(body);
  return Promise.resolve({ id: 'new-album', name: body.name } as Album);
};
albumsApi.list = (): Promise<Album[]> => Promise.resolve([]);
shootsApi.create = (body): Promise<Shoot> => {
  created.push(body);
  return Promise.resolve({ id: 'new-shoot', library_id: body.library_id } as Shoot);
};
shootsApi.list = (): Promise<Shoot[]> => Promise.resolve([]);
librariesApi.folders = (): ReturnType<typeof librariesApi.folders> => Promise.resolve([]);
photosApi.listLibrary = (): Promise<PhotoListResponse> =>
  Promise.resolve({ photos: [], photo_total: 0, offset: 0, limit: 1, ordering: 'taken_asc' });
// Never answered: the grid's re-read after the add is not what is under test.
albumsApi.addPhotos = (id, target): Promise<void> => {
  added.push({ kind: 'album', id, target });
  return new Promise(() => {});
};
shootsApi.addPhotos = (id, target): Promise<void> => {
  added.push({ kind: 'shoot', id, target });
  return new Promise(() => {});
};

let pathname = '';
function Location(): null {
  pathname = useLocation().pathname;
  return null;
}

const DAWN = { id: 'dawn', library_id: 'lib', folder_path: 'Dawn', is_hidden: false } as Shoot;
const REEF_WALK = { kind: 'album', id: 'reef-walk', name: 'Reef walk' } as const;

// The shoots are whichever library was browsed last, which an album page never changes.
function Seed({ onAlbum }: { onAlbum: boolean }): null {
  const libraries = useLibrariesStore();
  const listing = useListingStore();
  const marks = useMarksStore();
  const shoots = useShootsStore();
  useEffect(() => {
    runInAction(() => {
      libraries.libraries = [{ id: 'lib', name: 'Reef', read_only: false } as Library];
      shoots.libraryId = 'lib';
      shoots.shoots = [DAWN];
      listing.source = onAlbum ? { kind: 'album', albumId: REEF_WALK.id } : { kind: 'library', libraryId: 'lib' };
      listing.total = 1;
      listing.rows = new Map([[0, { id: 'p1', shoot_id: null, stack_size: 1 } as PhotoSummary]]);
      marks.selection = SelectionRanges.of(0, 0);
    });
  }, [libraries, listing, marks, shoots, onAlbum]);
  return null;
}

async function openSubmenu(submenu: string, onAlbum = false): Promise<void> {
  added.length = 0;
  created.length = 0;
  render(
    <MemoryRouter initialEntries={['/libraries/lib']}>
      <StoresProvider>
        <Seed onAlbum={onAlbum} />
        <Location />
        <BulkBar collection={onAlbum ? REEF_WALK : undefined} />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  for (const target of [
    () => screen.getByRole('button', { name: 'More actions' }),
    () => screen.getByRole('menuitem', { name: submenu }),
  ]) {
    await act(async () => {
      fireEvent.click(target());
    });
  }
}

async function createFrom(submenu: string, row: string, name: string, submit: string): Promise<void> {
  await openSubmenu(submenu);
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: row }));
  });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: name } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: submit }));
  });
}

test('a new album is made and the selection added to it, without leaving the grid', async () => {
  await createFrom('Add to album', 'Add to new album…', 'Reef walk', 'Create album');
  expect(created).toEqual([{ name: 'Reef walk', ordering: 'taken_asc' }]);
  expect(added.map(({ kind, id }) => ({ kind, id }))).toEqual([{ kind: 'album', id: 'new-album' }]);
  expect(pathname).toBe('/libraries/lib');
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a new shoot is made at the library root and the selection filed into it', async () => {
  await createFrom('Add to shoot', 'Add to new shoot…', 'Low tide', 'Create shoot');
  expect(created).toEqual([{ library_id: 'lib', parent_path: '', name: 'Low tide', ordering: 'taken_asc' }]);
  expect(added.map(({ kind, id }) => ({ kind, id }))).toEqual([{ kind: 'shoot', id: 'new-shoot' }]);
  expect(pathname).toBe('/libraries/lib');
});

test('an album offers no shoot to file into, though the last library browsed has one', async () => {
  await openSubmenu('Add to album', true);
  expect(screen.queryByRole('menuitem', { name: 'Add to shoot' })).toBeNull();
});
