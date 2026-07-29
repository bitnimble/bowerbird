import { describe, expect, test } from 'bun:test';
import type { Shoot } from '../../../api/client';
import { SHOOT_ROW_H, ShootsStore } from '../shoots_store';
import { ShootsPresenter } from '../shoots_presenter';

function shoot(folder_path: string): Shoot {
  return {
    id: `id:${folder_path}`,
    parent_id: null,
    library_id: 'lib',
    folder_path,
    name: folder_path.slice(folder_path.lastIndexOf('/') + 1),
    description: null,
    banner_photo_id: null,
    ordering: 'taken_asc',
    photo_count: 0,
  };
}

// A tall list in the flat view, so rows are exactly the shoots and the arithmetic
// is easy to state: row i sits at i * SHOOT_ROW_H.
function build(rows = 500): { store: ShootsStore; presenter: ShootsPresenter } {
  const store = new ShootsStore();
  store.view = 'flat';
  store.shoots = Array.from({ length: rows }, (_, i) => shoot(`f${String(i).padStart(4, '0')}`));
  store.viewportHeight = 470; // ten rows
  return { store, presenter: new ShootsPresenter(store) };
}

describe('the keyboard cursor', () => {
  test('starts at the top and walks the list', () => {
    const { store, presenter } = build();
    expect(store.cursorIndex).toBe(-1);

    presenter.moveCursor(1);
    expect(store.cursorIndex).toBe(0);

    presenter.moveCursor(1);
    presenter.moveCursor(1);
    expect(store.cursorRow?.folderPath).toBe('f0002');
  });

  test('clamps at both ends rather than wrapping', () => {
    const { store, presenter } = build(3);
    presenter.moveCursor(-1);
    expect(store.cursorIndex).toBe(2); // an upward first step starts at the end
    presenter.moveCursor(-99);
    expect(store.cursorIndex).toBe(0);
    presenter.moveCursor(99);
    expect(store.cursorIndex).toBe(2);
  });

  // The whole point: the cursor names a row that has never been mounted, so the
  // scroll target has to come from arithmetic rather than from an element.
  test('asks for the scroll that brings an unmounted row on screen', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0400');

    // Well past the rendered window, which is ten rows from the top.
    expect(store.visible.to).toBeLessThan(400);
    // Scrolled so the row's bottom sits on the viewport's bottom edge.
    expect(store.cursorScrollTop).toBe(401 * SHOOT_ROW_H - 470);
  });

  test('asks for nothing while the cursor is already on screen', () => {
    const { store, presenter } = build();
    store.scrollTop = 0;
    presenter.setCursor('f0005');
    expect(store.cursorScrollTop).toBeNull();
  });

  test('scrolls up to a cursor above the window', () => {
    const { store, presenter } = build();
    store.scrollTop = 100 * SHOOT_ROW_H;
    presenter.setCursor('f0050');
    expect(store.cursorScrollTop).toBe(50 * SHOOT_ROW_H);
  });

  // Rows are renumbered by every expand, collapse and view change, which is why
  // the cursor is a folder path and not an index.
  test('stays on its folder when the rows around it are renumbered', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0100');
    expect(store.cursorIndex).toBe(100);

    // A shoot arrives above it, as a sync tick would deliver.
    store.shoots = [shoot('a-new-one'), ...store.shoots];

    expect(store.cursorRow?.folderPath).toBe('f0100');
    expect(store.cursorIndex).toBe(101);
  });

  test('reports no row once its folder has gone', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0100');
    store.shoots = store.shoots.filter((s) => s.folder_path !== 'f0100');

    expect(store.cursorIndex).toBe(-1);
    expect(store.cursorRow).toBeNull();
    expect(store.cursorScrollTop).toBeNull();

    // And a keystroke picks the list back up rather than doing nothing.
    presenter.moveCursor(1);
    expect(store.cursorIndex).toBe(0);
  });
});
