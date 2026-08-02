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

  // Flat and Tree list the same shoots in the same order, so the index does not
  // move - but the list has been scrolled and still has to come back to it.
  test('asks to be followed again even when the index did not change', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0400');
    const seq = store.cursorSeq;

    presenter.setCursor('f0400');

    expect(store.cursorIndex).toBe(400);
    expect(store.cursorSeq).toBeGreaterThan(seq);
  });

  test('refuses a folder that is not a row', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0001');
    presenter.setCursor('nothing/here');
    expect(store.cursorRow?.folderPath).toBe('f0001');
  });

  describe('when rows disappear under it', () => {
    test('settles onto the row that took its place', () => {
      const { store, presenter } = build(10);
      presenter.setCursor('f0005');

      store.shoots = store.shoots.filter((s) => s.folder_path !== 'f0005');
      presenter.settleCursor();

      // Where the old row was, which is now its neighbour - not the top.
      expect(store.cursorRow?.folderPath).toBe('f0006');
    });

    test('settles onto the last row when the list shrank past it', () => {
      const { store, presenter } = build(10);
      presenter.setCursor('f0009');

      store.shoots = store.shoots.slice(0, 3);
      presenter.settleCursor();

      expect(store.cursorRow?.folderPath).toBe('f0002');
    });

    test('clears itself when nothing is left', () => {
      const { store, presenter } = build(3);
      presenter.setCursor('f0001');

      store.shoots = [];
      presenter.settleCursor();

      expect(store.cursorPath).toBeNull();
    });

    test('leaves a cursor that still resolves alone', () => {
      const { store, presenter } = build(10);
      presenter.setCursor('f0005');
      presenter.settleCursor();
      expect(store.cursorRow?.folderPath).toBe('f0005');
    });
  });

  describe('the tree arrows', () => {
    test('right opens a closed folder rather than moving', async () => {
      const { store, presenter } = build(0);
      store.view = 'tree_full';
      store.browsed = new Map([['', ['a']], ['a', ['a/b']]]);
      presenter.setCursor('a');
      expect(store.expanded.has('a')).toBe(false);

      await presenter.openCursor();

      expect(store.expanded.has('a')).toBe(true);
      expect(store.cursorRow?.folderPath).toBe('a'); // still on the folder it opened
    });

    test('left closes an open folder, keeping the cursor on it', async () => {
      const { store, presenter } = build(0);
      store.view = 'tree_full';
      store.browsed = new Map([['', ['a']], ['a', ['a/b']]]);
      store.expanded = new Set(['', 'a']);
      presenter.setCursor('a');

      await presenter.closeCursor();

      expect(store.expanded.has('a')).toBe(false);
      expect(store.cursorRow?.folderPath).toBe('a');
    });

    // The parent may be a folder the reading skips over, and in flat view there
    // are no ancestors at all - either way the cursor must land on a real row.
    test('left steps out to the nearest ancestor that is a row', async () => {
      const { store, presenter } = build(0);
      store.view = 'tree_full';
      store.browsed = new Map([['', ['a']], ['a', ['a/b']], ['a/b', ['a/b/c']]]);
      store.expanded = new Set(['', 'a', 'a/b']);
      presenter.setCursor('a/b/c');

      await presenter.closeCursor();

      expect(store.cursorRow?.folderPath).toBe('a/b');
    });

    test('left does nothing at the top of a flat list', async () => {
      const { store, presenter } = build();
      presenter.setCursor('f0003');

      await presenter.closeCursor();

      expect(store.cursorRow?.folderPath).toBe('f0003');
    });

    test('a leaf has no expand arrow', () => {
      const { store } = build(0);
      store.view = 'tree_full';
      store.browsed = new Map([['', ['a']], ['a', ['a/b']], ['a/b', []]]);
      store.expanded = new Set(['', 'a']);

      const parent = store.rows.find((r) => r.folderPath === 'a');
      const leaf = store.rows.find((r) => r.folderPath === 'a/b');
      expect(parent?.expandable).toBe(true);
      expect(leaf?.expandable).toBe(false);
    });

    test('an unbrowsed folder stays expandable so empty children can be found', () => {
      const { store } = build(0);
      store.view = 'tree_full';
      store.browsed = new Map([['', ['a']]]);
      store.expanded = new Set(['']);

      const row = store.rows.find((r) => r.folderPath === 'a');
      expect(row?.expandable).toBe(true);
    });
  });

  test('reports no row once its folder has gone', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0100');
    store.shoots = store.shoots.filter((s) => s.folder_path !== 'f0100');

    expect(store.cursorIndex).toBe(-1);
    expect(store.cursorRow).toBeNull();
    expect(store.cursorScrollTop).toBeNull();

    // And a keystroke resumes where that folder was rather than teleporting the
    // reader to the top of a list they were a hundred rows into.
    presenter.moveCursor(1);
    expect(store.cursorIndex).toBe(100);
  });
});
