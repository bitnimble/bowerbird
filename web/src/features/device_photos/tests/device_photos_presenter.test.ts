import { describe, expect, test } from 'bun:test';
import type { Library } from '../../../../../src/schemas/libraries';
import type { PhotoAccess, PhotoAsk } from '../../../api/transport';
import { isSyncedCopy } from '../../../app/thin_shell';
import { LibrariesStore } from '../../libraries/libraries_store';
import { DevicePhotosPresenter } from '../device_photos_presenter';
import { DevicePhotosStore } from '../device_photos_store';

const CAMERA = '/storage/emulated/0/DCIM';

function access(photos: PhotoAccess['photos']): PhotoAccess {
  return { photos, manageable: true, managed: false, cameraFolder: CAMERA };
}

/** A phone whose reader answers every read prompt with `answer`, and leaves settings at `settled`. */
function phone(
  start: PhotoAccess['photos'],
  answer: PhotoAccess['photos'],
  settled: PhotoAccess['photos'] = start,
) {
  const libraries = new LibrariesStore();
  const store = new DevicePhotosStore(libraries);
  const asked: PhotoAsk[] = [];
  const scanned: string[] = [];
  const errors: string[] = [];
  const presenter = new DevicePhotosPresenter(
    store,
    {
      access: () => Promise.resolve(access(start)),
      ask: (ask) => {
        asked.push(ask);
        return Promise.resolve(access(ask === 'read' ? answer : settled));
      },
    },
    { scanLibrary: (libraryId) => Promise.resolve(void scanned.push(libraryId)) },
    { showError: (message) => void errors.push(message) },
  );
  return { libraries, store, presenter, asked, scanned, errors };
}

describe('adding the phone photos', () => {
  test('asks to read them first, then offers the camera folder with its JPEGs and HEICs', async () => {
    const { presenter, store, asked } = phone('none', 'all');
    await presenter.load();

    await presenter.addLibrary();

    expect(asked).toEqual(['read']);
    expect(store.adding).toBe(true);
    expect(store.newLibrary).toEqual({
      root_path: CAMERA,
      name: 'Phone',
      read_only: false,
      bin_name: 'Bin',
      ordering: 'taken_desc',
      include_subfolders: true,
      include_non_raw: true,
      rendition_source: 'embedded',
      render_skip_full: ['dust'],
      render_skip_max: ['dust'],
      auto_stack: true,
      denoiser: 'galosh',
    });
  });

  test('a reader who allows some photos is still offered the library', async () => {
    const { presenter, store } = phone('none', 'selected');
    await presenter.load();

    await presenter.addLibrary();

    expect(store.adding).toBe(true);
    expect(store.newLibrary?.root_path).toBe(CAMERA);
  });

  test('a reader who allows none is offered no library, and the way to settings', async () => {
    const { presenter, store } = phone('none', 'none');
    await presenter.load();

    await presenter.addLibrary();

    expect(store.adding).toBe(false);
    expect(store.newLibrary).toBeNull();
    expect(store.refused).toBe(true);
  });

  test('closing the dialog keeps its folder for the close', async () => {
    const { presenter, store } = phone('all', 'all');
    await presenter.load();
    await presenter.addLibrary();

    presenter.setAdding(false);

    expect(store.adding).toBe(false);
    expect(store.newLibrary?.root_path).toBe(CAMERA);
  });

  test('access allowed in system settings afterwards takes the way to settings away', async () => {
    const { presenter, store } = phone('none', 'none', 'all');
    await presenter.load();
    await presenter.addLibrary();
    expect(store.refused).toBe(true);

    await presenter.openSettings();

    expect(store.refused).toBe(false);
  });

  test('a second tap while the first is asking asks nothing more', async () => {
    const { presenter, asked } = phone('none', 'all');
    await presenter.load();

    await Promise.all([presenter.addLibrary(), presenter.addLibrary()]);

    expect(asked).toEqual(['read']);
  });

  test('access already given is not asked for again', async () => {
    const { presenter, store, asked } = phone('all', 'all');
    await presenter.load();

    await presenter.addLibrary();

    expect(asked).toEqual([]);
    expect(store.adding).toBe(true);
  });
});

test('choosing other photos scans the phone library for what that changed', async () => {
  const { presenter, libraries, scanned } = phone('selected', 'selected');
  libraries.libraries = [{ id: 'phone', root_path: CAMERA } as Library];
  await presenter.load();

  await presenter.choosePhotos();

  expect(scanned).toEqual(['phone']);
});

test('the phone library is the camera folder and what is under it, nothing else', async () => {
  const { presenter, store } = phone('all', 'all');
  await presenter.load();

  expect(store.holds({ root_path: CAMERA })).toBe(true);
  expect(store.holds({ root_path: `${CAMERA}/Camera` })).toBe(true);
  expect(store.holds({ root_path: `${CAMERA}2` })).toBe(false);
  expect(store.holds({ root_path: '/data/user/0/photos.bowerbird/libraries/abc' })).toBe(false);
  // Outside the mobile app nothing is a synced copy, however the store answers.
  expect(isSyncedCopy({ root_path: '/data/user/0/photos.bowerbird/libraries/abc' }, store)).toBe(
    false,
  );
});
