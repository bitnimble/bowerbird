// Two readers of one list. The sidebar fetches a library's shoots when its section is
// opened, and the Shoots page hands over whatever it has just read - so whichever
// of them is still in flight must not land on top of the other.
import { beforeEach, expect, test } from 'bun:test';
import { type Shoot } from '../../../../src/schemas/shoots';
import { shootsApi } from '../../api/shoots';
import { restoreApiAfterTests } from '../../test_api';
import { MemoryStorage } from '../../test_storage';
import { SidebarPresenter } from '../sidebar_presenter';
import { SidebarStore } from '../sidebar_store';
import { AppSettingsStore } from '../../features/settings/app_settings_store';
import { PathSegment, route } from '../../../../src/schemas/route';

restoreApiAfterTests();
// Every presenter below is built fresh and reads what is stored as it is built, so
// what one test leaves written would decide where the next one starts.
beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
});

function shoot(name: string): Shoot {
  return {
    id: name,
    parent_id: null,
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

function build(): { store: SidebarStore; presenter: SidebarPresenter } {
  const store = new SidebarStore(new AppSettingsStore());
  return { store, presenter: new SidebarPresenter(store) };
}

const names = (store: SidebarStore): string[] => (store.shootsByLibrary.get('lib') ?? []).map((s) => s.name);

// The sidebar is chrome, so what the reader did to it is theirs to come back to.
test('what was opened and how wide it was dragged come back', () => {
  const first = build();
  first.presenter.toggle('library:lib');
  first.presenter.toggle('shoots:lib');
  first.presenter.setWidth(320);

  const { store } = build();
  expect(store.isOpen('library:lib')).toBe(false);
  expect(store.isOpen('shoots:lib')).toBe(true);
  expect(store.width).toBe(320);
});

test('a section toggled back is remembered as never touched', () => {
  const { presenter } = build();
  presenter.toggle('albums');
  presenter.toggle('albums');

  const { store } = build();
  expect(store.isOpen('albums')).toBe(false);
  expect(store.toggled.size).toBe(0);
});

// A drag can leave the pointer anywhere, including off the window.
test('a width is held between a sidebar you can read and a page you can still use', () => {
  const { store, presenter } = build();

  presenter.setWidth(10);
  const floor = store.width!;
  presenter.setWidth(-400);
  expect(store.width).toBe(floor);

  presenter.setWidth(4000);
  const ceiling = store.width!;
  expect(ceiling).toBeGreaterThan(floor);
  presenter.setWidth(100_000);
  expect(store.width).toBe(ceiling);

  // The arrows move it by a step, and stop where the drag stops.
  presenter.setWidth(300);
  presenter.nudgeWidth(1);
  const stepped = store.width!;
  expect(stepped).toBeGreaterThan(300);
  presenter.nudgeWidth(-1);
  expect(store.width).toBe(300);
  for (let i = 0; i < 100; i++) presenter.nudgeWidth(-1);
  expect(store.width).toBe(floor);
});

test('a library is read once, however many rows ask for it', async () => {
  let reads = 0;
  shootsApi.list = (): Promise<Shoot[]> => {
    reads++;
    return Promise.resolve([shoot('Dawn')]);
  };
  const { store, presenter } = build();

  await Promise.all([presenter.loadShoots('lib'), presenter.loadShoots('lib')]);
  await presenter.loadShoots('lib');

  expect(reads).toBe(1);
  expect(names(store)).toEqual(['Dawn']);
});

test('a read that fails leaves nothing behind, so opening the row again retries', async () => {
  let reads = 0;
  shootsApi.list = (): Promise<Shoot[]> => {
    reads++;
    return reads === 1 ? Promise.reject(new Error('no')) : Promise.resolve([shoot('Dawn')]);
  };
  const { store, presenter } = build();

  await presenter.loadShoots('lib');
  expect(store.shootsByLibrary.has('lib')).toBe(false);

  await presenter.loadShoots('lib');
  expect(names(store)).toEqual(['Dawn']);
});

test('a failed read does not take the list the Shoots page handed over with it', async () => {
  shootsApi.list = (): Promise<Shoot[]> => Promise.reject(new Error('no'));
  const { store, presenter } = build();

  const reading = presenter.loadShoots('lib');
  presenter.adopt('lib', [shoot('Reykjavik')]);
  await reading;

  expect(names(store)).toEqual(['Reykjavik']);
});

test('a read that lands late does not put a renamed shoot back', async () => {
  let answer: (shoots: Shoot[]) => void = () => {};
  shootsApi.list = (): Promise<Shoot[]> => new Promise((resolve) => (answer = resolve));
  const { store, presenter } = build();

  const reading = presenter.loadShoots('lib');
  // The page reads the same library, renames, and re-reads - all while the sidebar's
  // own request is still out.
  presenter.adopt('lib', [shoot('Harpa at dusk')]);
  answer([shoot('Harpa')]);
  await reading;

  expect(names(store)).toEqual(['Harpa at dusk']);
});

test('collapsing the sidebar on a desktop is remembered', () => {
  const first = build();
  expect(first.store.open).toBe(true);
  first.presenter.toggleOpen();
  expect(first.store.open).toBe(false);

  expect(build().store.open).toBe(false);
});

test('the viewer hides the sidebar, a reveal lasts until leaving it, and the preference is untouched', () => {
  const { store, presenter } = build();
  presenter.navigated(route(PathSegment.photos(), 'abc'));
  expect(store.open).toBe(false);

  presenter.toggleOpen();
  expect(store.open).toBe(true);
  presenter.navigated(route(PathSegment.libraries(), 'lib'));
  presenter.navigated(route(PathSegment.photos(), 'abc'));
  expect(store.open).toBe(false);

  presenter.navigated(route(PathSegment.libraries(), 'lib'));
  expect(store.open).toBe(true);
  expect(build().store.open).toBe(true);
});

test('on a phone the sidebar is a drawer, shut by default and on every navigation', () => {
  const { store, presenter } = build();
  presenter.setMobile(true);
  expect(store.open).toBe(false);

  presenter.toggleOpen();
  expect(store.open).toBe(true);
  presenter.navigated(route(PathSegment.settings()));
  expect(store.open).toBe(false);
});
