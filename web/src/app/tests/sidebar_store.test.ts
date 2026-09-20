// What the sidebar nests and what it starts open, which is everything about it that
// is not a stylesheet.
import { expect, test } from 'bun:test';
import { type Shoot } from '../../../../src/schemas/shoots';
import { SidebarStore } from '../sidebar_store';
import { AppSettingsStore } from '../../features/settings/app_settings_store';

function shoot(id: string, parent_id: string | null, name = id): Shoot {
  return {
    id,
    parent_id,
    library_id: 'lib',
    folder_path: name,
    name,
    description: null,
    banner_photo_id: null,
    ordering: 'taken_asc',
    photo_count: 0,
    is_hidden: false,
    hidden_directly: false,
  };
}

test('shoots nest under their parent, alphabetically at every level', () => {
  const store = new SidebarStore(new AppSettingsStore());
  store.shootsByLibrary.set('lib', [
    shoot('wharf', null, 'Wharf'),
    shoot('reef', null, 'Reef'),
    shoot('dusk', 'reef', 'Dusk'),
    shoot('dawn', 'reef', 'Dawn'),
    shoot('gulls', 'dawn', 'Gulls'),
  ]);

  const roots = store.shootTrees.get('lib')!;
  expect(roots.map((n) => n.shoot.name)).toEqual(['Reef', 'Wharf']);
  expect(roots[0]!.children.map((n) => n.shoot.name)).toEqual(['Dawn', 'Dusk']);
  expect(roots[0]!.children[0]!.children.map((n) => n.shoot.name)).toEqual(['Gulls']);
});

// A shoot whose parent is filed in another library, or has just been deleted,
// is still somewhere the reader can go.
test('a shoot whose parent is not on the list stands at the root', () => {
  const store = new SidebarStore(new AppSettingsStore());
  store.shootsByLibrary.set('lib', [shoot('orphan', 'gone')]);
  expect(store.shootTrees.get('lib')!.map((n) => n.shoot.id)).toEqual(['orphan']);
});

test('a library opens and everything under it starts shut', () => {
  const store = new SidebarStore(new AppSettingsStore());
  expect(store.isOpen('library:lib')).toBe(true);
  expect(store.isOpen('shoots:lib')).toBe(false);
  expect(store.isOpen('albums')).toBe(false);

  store.toggled.add('library:lib');
  store.toggled.add('albums');
  expect(store.isOpen('library:lib')).toBe(false);
  expect(store.isOpen('albums')).toBe(true);
});
