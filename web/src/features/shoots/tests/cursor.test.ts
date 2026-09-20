import { beforeEach, describe, expect, test } from 'bun:test';
import { type Shoot } from '../../../../../src/schemas/shoots';
import { LIST_ROW_H } from '../../../app/collection_list_store';
import { SidebarPresenter } from '../../../app/sidebar_presenter';
import { SidebarStore } from '../../../app/sidebar_store';
import { AppSettingsStore } from '../../settings/app_settings_store';
import { MemoryStorage } from '../../../test_storage';
import { NO_SHOOT_PATH, ShootsStore } from '../shoots_store';
import { ShootsPresenter } from '../shoots_presenter';

// The sidebar presenter these build reads its remembered sections as it is constructed,
// and the runner is shared: without this, what another file wrote decides what it holds.
beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

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
    is_hidden: false,
    hidden_directly: false,
  };
}

// A tall list in the flat view. Row 0 is the photographs in no shoot, so shoot i
// is row i + 1, sitting at (i + 1) * LIST_ROW_H.
function build(rows = 500): { store: ShootsStore; presenter: ShootsPresenter } {
  const store = new ShootsStore();
  store.view = 'flat';
  store.rootPhotoCount = 7; // enough for the row that leads the list to exist
  store.shoots = Array.from({ length: rows }, (_, i) => shoot(`f${String(i).padStart(4, '0')}`));
  store.viewportHeight = 470; // ten rows
  return { store, presenter: new ShootsPresenter(store, new SidebarPresenter(new SidebarStore(new AppSettingsStore()))) };
}

describe('the keyboard cursor', () => {
  test('starts at the top and walks the list', () => {
    const { store, presenter } = build();
    expect(store.cursorIndex).toBe(-1);

    presenter.moveCursor(1);
    expect(store.cursorRow?.key).toBe(NO_SHOOT_PATH);

    presenter.moveCursor(1);
    presenter.moveCursor(1);
    expect(store.cursorRow?.key).toBe('f0001');
  });

  test('the photographs in no shoot lead every reading', () => {
    const { store } = build(3);
    for (const view of ['flat', 'tree', 'tree_full'] as const) {
      store.view = view;
      expect(store.rows[0]?.key).toBe(NO_SHOOT_PATH);
    }
  });

  test('clamps at both ends rather than wrapping', () => {
    const { store, presenter } = build(3);
    presenter.moveCursor(-1);
    expect(store.cursorIndex).toBe(3); // an upward first step starts at the end
    presenter.moveCursor(-99);
    expect(store.cursorIndex).toBe(0);
    presenter.moveCursor(99);
    expect(store.cursorIndex).toBe(3);
  });

  // The whole point: the cursor names a row that has never been mounted, so the
  // scroll target has to come from arithmetic rather than from an element.
  test('asks for the scroll that brings an unmounted row on screen', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0400');

    // Well past the rendered window, which is ten rows from the top.
    expect(store.visible.to).toBeLessThan(400);
    // Scrolled so the row's bottom sits on the viewport's bottom edge.
    expect(store.cursorScrollTop).toBe(402 * LIST_ROW_H - 470);
  });

  test('asks for nothing while the cursor is already on screen', () => {
    const { store, presenter } = build();
    store.scrollTop = 0;
    presenter.setCursor('f0005');
    expect(store.cursorScrollTop).toBeNull();
  });

  test('scrolls up to a cursor above the window', () => {
    const { store, presenter } = build();
    store.scrollTop = 100 * LIST_ROW_H;
    presenter.setCursor('f0050');
    expect(store.cursorScrollTop).toBe(51 * LIST_ROW_H);
  });

  // Rows are renumbered by every expand, collapse and view change, which is why
  // the cursor is a folder path and not an index.
  test('stays on its folder when the rows around it are renumbered', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0100');
    expect(store.cursorIndex).toBe(101);

    // A shoot arrives above it, as a sync tick would deliver.
    store.shoots = [shoot('a-new-one'), ...store.shoots];

    expect(store.cursorRow?.key).toBe('f0100');
    expect(store.cursorIndex).toBe(102);
  });

  // Flat and Tree list the same shoots in the same order, so the index does not
  // move - but the list has been scrolled and still has to come back to it.
  test('asks to be followed again even when the index did not change', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0400');
    const seq = store.cursorSeq;

    presenter.setCursor('f0400');

    expect(store.cursorIndex).toBe(401);
    expect(store.cursorSeq).toBeGreaterThan(seq);
  });

  test('refuses a folder that is not a row', () => {
    const { store, presenter } = build();
    presenter.setCursor('f0001');
    presenter.setCursor('nothing/here');
    expect(store.cursorRow?.key).toBe('f0001');
  });

  describe('when rows disappear under it', () => {
    test('settles onto the row that took its place', () => {
      const { store, presenter } = build(10);
      presenter.setCursor('f0005');

      store.shoots = store.shoots.filter((s) => s.folder_path !== 'f0005');
      presenter.settleCursor();

      // Where the old row was, which is now its neighbour - not the top.
      expect(store.cursorRow?.key).toBe('f0006');
    });

    test('settles onto the last row when the list shrank past it', () => {
      const { store, presenter } = build(10);
      presenter.setCursor('f0009');

      store.shoots = store.shoots.slice(0, 3);
      presenter.settleCursor();

      expect(store.cursorRow?.key).toBe('f0002');
    });

    test('settles onto the photographs in no shoot when every shoot has gone', () => {
      const { store, presenter } = build(3);
      presenter.setCursor('f0001');

      store.shoots = [];
      presenter.settleCursor();

      expect(store.cursorKey).toBe(NO_SHOOT_PATH);
    });

    test('leaves a cursor that still resolves alone', () => {
      const { store, presenter } = build(10);
      presenter.setCursor('f0005');
      presenter.settleCursor();
      expect(store.cursorRow?.key).toBe('f0005');
    });
  });

  describe('the tree arrows', () => {
    test('right opens a closed folder rather than moving', () => {
      const { store, presenter } = build(0);
      store.view = 'tree_full';
      store.folders = ['a', 'a/b'];
      presenter.setCursor('a');
      expect(store.expanded.has('a')).toBe(false);

      presenter.openCursor();

      expect(store.expanded.has('a')).toBe(true);
      expect(store.cursorRow?.key).toBe('a'); // still on the folder it opened
    });

    test('left closes an open folder, keeping the cursor on it', () => {
      const { store, presenter } = build(0);
      store.view = 'tree_full';
      store.folders = ['a', 'a/b'];
      store.expanded = new Set(['', 'a']);
      presenter.setCursor('a');

      presenter.closeCursor();

      expect(store.expanded.has('a')).toBe(false);
      expect(store.cursorRow?.key).toBe('a');
    });

    // The parent may be a folder the reading skips over, and in flat view there
    // are no ancestors at all - either way the cursor must land on a real row.
    test('left steps out to the nearest ancestor that is a row', () => {
      const { store, presenter } = build(0);
      store.view = 'tree_full';
      store.folders = ['a', 'a/b', 'a/b/c'];
      store.expanded = new Set(['', 'a', 'a/b']);
      presenter.setCursor('a/b/c');

      presenter.closeCursor();

      expect(store.cursorRow?.key).toBe('a/b');
    });

    test('left does nothing at the top of a flat list', () => {
      const { store, presenter } = build();
      presenter.setCursor('f0003');

      presenter.closeCursor();

      expect(store.cursorRow?.key).toBe('f0003');
    });

    // The whole tree arrives at once, so a folder with nothing under it says so
    // before it is clicked rather than by losing its chevron under the click.
    test('a leaf has no expand arrow', () => {
      const { store } = build(0);
      store.view = 'tree_full';
      store.folders = ['a', 'a/b'];
      store.expanded = new Set(['', 'a']);

      const parent = store.rows.find((r) => r.key === 'a');
      const leaf = store.rows.find((r) => r.key === 'a/b');
      expect(parent?.expandable).toBe(true);
      expect(leaf?.expandable).toBe(false);
    });

    test('a folder holding only empty folders still opens', () => {
      const { store } = build(0);
      store.view = 'tree_full';
      store.folders = ['a', 'a/empty'];
      store.expanded = new Set(['']);

      const row = store.rows.find((r) => r.key === 'a');
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
    expect(store.cursorIndex).toBe(101);
  });
});
