import { describe, expect, test } from 'bun:test';
import { PathSegment, route } from '../../../../../src/schemas/route';
import { type Album } from '../../../../../src/schemas/albums';
import { LIST_ROW_H } from '../../../app/collection_list_store';
import { AlbumsPresenter } from '../albums_presenter';
import { AlbumsStore } from '../albums_store';

function album(name: string, photo_count = 3): Album {
  return {
    id: `id:${name}`,
    name,
    banner_photo_id: null,
    ordering: 'taken_asc',
    photo_count,
  };
}

function build(count = 500): { store: AlbumsStore; presenter: AlbumsPresenter } {
  const store = new AlbumsStore();
  store.albums = Array.from({ length: count }, (_, i) => album(`a${String(i).padStart(4, '0')}`));
  store.viewportHeight = 10 * LIST_ROW_H;
  return { store, presenter: new AlbumsPresenter(store) };
}

describe('the albums list', () => {
  test('is the same list the shoots page scrolls, without the folders', () => {
    const row = build(1).store.rows[0]!;
    expect(row.key).toBe('id:a0000');
    expect(row.href).toBe(route(PathSegment.albums(), 'id:a0000'));
    expect(row.meta).toBe('Oldest first · 3 photos');
    expect(row.expandable).toBe(false);
    expect(row.depth).toBe(0);
  });

  test('walks under the keyboard and asks for the scroll that shows an unmounted row', () => {
    const { store, presenter } = build();
    presenter.moveCursor(1);
    expect(store.cursorRow?.name).toBe('a0000');

    presenter.setCursor('id:a0400');
    expect(store.visible.to).toBeLessThan(400);
    expect(store.cursorScrollTop).toBe(401 * LIST_ROW_H - 10 * LIST_ROW_H);
  });

  test('settles the cursor onto the row that took a deleted one place', () => {
    const { store, presenter } = build(10);
    presenter.setCursor('id:a0005');

    store.albums = store.albums.filter((a) => a.id !== 'id:a0005');
    presenter.settleCursor();

    expect(store.cursorRow?.name).toBe('a0006');
  });
});
