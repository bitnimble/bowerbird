// What the page does with an update, against a recording API. The thing worth pinning
// here is the restart: the server exits as soon as it has answered, so every request
// after `apply` fails until the new version is up, and a page that reloads on the click
// reloads into nothing.
import { expect, test } from 'bun:test';
import { type ModelsStatus } from '../../../../../src/schemas/models';
import { type UpdateStatus } from '../../../../../src/schemas/updates';
import { modelsApi } from '../../../api/models';
import { updatesApi } from '../../../api/updates';
import { ConfirmPresenter } from '../../confirm/confirm_presenter';
import { ConfirmStore } from '../../confirm/confirm_store';
import { restoreApiAfterTests } from '../../../test_api';
import { UpdatesPresenter } from '../updates_presenter';
import { UpdatesStore } from '../updates_store';
import { UpdatesStrings } from '../updates.strings';

restoreApiAfterTests();

function status(current: string, newer: string[], canInstall = true): UpdateStatus {
  return {
    current,
    checks: true,
    newer: newer.map((version) => ({
      version,
      tag: `v${version}`,
      name: `Bowerbird ${version}`,
      notes: `## What's new\n* a thing`,
      published_at: '2026-09-09T00:00:00.000Z',
      // Opaque to the page - whatever the release said its own page was - so a fictional
      // one, rather than a string that looks like configuration and invites being kept
      // in step with it.
      url: `https://example.invalid/releases/tag/v${version}`,
    })),
    can_install: canInstall,
    install_hint: 'https://example.invalid/Bowerbird.AppImage',
    checked_at: '2026-09-09T00:00:00.000Z',
    error: null,
  };
}

// The restart's two real-world quantities - a page reload and a five-minute wait - stubbed
// so the poll can be watched rather than waited out.
function open(): {
  store: UpdatesStore;
  presenter: UpdatesPresenter;
  reloads: number[];
  confirm: ConfirmPresenter;
  asked: ConfirmStore;
} {
  const store = new UpdatesStore();
  const reloads: number[] = [];
  const asked = new ConfirmStore();
  const confirm = new ConfirmPresenter(asked);
  const presenter = new UpdatesPresenter(store, confirm, {
    reload: () => reloads.push(Date.now()),
    pollMs: 1,
    timeoutMs: 60,
  });
  modelsApi.get = () => Promise.resolve(models(null));
  return { store, presenter, reloads, confirm, asked };
}

function models(available: string | null, downloaded = false): ModelsStatus {
  return {
    upscaler: {
      current: { revision: 'bundled', committed_at: '2026-10-01T00:00:00.000Z', downloaded },
      available:
        available == null
          ? null
          : { revision: available, committed_at: '2026-10-09T00:00:00.000Z', bytes: 8_270_080 },
      downloading: false,
    },
    checked_at: '2026-10-09T00:00:00.000Z',
    error: null,
  };
}

test('a check with nothing newer leaves the sidebar with no badge', async () => {
  const { store, presenter } = open();
  updatesApi.get = () => Promise.resolve(status('0.2.0', []));
  await presenter.check();
  expect(store.available).toBeNull();
  expect(store.current).toBe('0.2.0');
});

// Cumulative: somebody who has not opened the app for three months is owed the three
// months, not only whatever the newest release happens to say.
test('every release newer than this one is offered, newest first', async () => {
  const { store, presenter } = open();
  updatesApi.get = () => Promise.resolve(status('0.1.0', ['0.3.0', '0.2.0']));
  await presenter.check();
  expect(store.newer.map((release) => release.version)).toEqual(['0.3.0', '0.2.0']);
  expect(store.available?.version).toBe('0.3.0');
});

test('the manual check skips the cache; the automatic one does not', async () => {
  const { presenter } = open();
  const asked: string[] = [];
  updatesApi.get = () => {
    asked.push('cached');
    return Promise.resolve(status('0.2.0', []));
  };
  updatesApi.check = () => {
    asked.push('fresh');
    return Promise.resolve(status('0.2.0', []));
  };
  await presenter.check();
  await presenter.check(true);
  expect(asked).toEqual(['cached', 'fresh']);
});

// The check runs hourly in the background and must never put an error in front of
// anybody: a library on a machine with no route to the internet works perfectly.
test('a check that cannot reach the server is recorded, not thrown', async () => {
  const { store, presenter } = open();
  updatesApi.get = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
  await presenter.check();
  expect(store.failure).toBe('getaddrinfo ENOTFOUND');
  expect(store.available).toBeNull();
});

test('an install that is refused leaves the button usable again', async () => {
  const { store, presenter } = open();
  updatesApi.get = () => Promise.resolve(status('0.1.0', ['0.2.0']));
  await presenter.check();
  updatesApi.apply = () => Promise.reject(new Error('no payload for linux-x86_64'));
  await presenter.install();
  expect(store.install).toBe('idle');
  expect(store.failure).toBe('no payload for linux-x86_64');
});

// The reason the reload is not at the click: the server exits as soon as it has answered,
// so every request between the click and the updater starting the new version fails.
// A page reloaded into that is a blank screen with no way to tell it was ever working.
test('the page reloads only once the new version is the one answering', async () => {
  const { store, presenter, reloads } = open();
  updatesApi.get = () => Promise.resolve(status('0.1.0', ['0.2.0']));
  await presenter.check();

  let asked = 0;
  const phases: string[] = [];
  updatesApi.apply = () => {
    phases.push(store.install);
    return Promise.resolve(status('0.1.0', ['0.2.0']));
  };
  updatesApi.get = () => {
    phases.push(store.install);
    asked += 1;
    // Down for the first two polls, which is the whole of the restart.
    if (asked < 3) return Promise.reject(new Error('connection refused'));
    return Promise.resolve(status('0.2.0', []));
  };

  await presenter.install();
  expect(reloads).toHaveLength(1);
  expect(asked).toBeGreaterThanOrEqual(3);
  expect(store.failure).toBeNull();
  expect(phases).toEqual(['downloading', ...Array<string>(asked).fill('restarting')]);
});

// Everything is installed and the reader has to start it themselves - which is a different
// thing to say than "the update failed", and the only thing the page can say truthfully.
test('a version that never comes back says so rather than waiting for ever', async () => {
  const { store, presenter, reloads } = open();
  updatesApi.get = () => Promise.resolve(status('0.1.0', ['0.2.0']));
  await presenter.check();

  updatesApi.apply = () => Promise.resolve(status('0.1.0', ['0.2.0']));
  updatesApi.get = () => Promise.reject(new Error('connection refused'));

  await presenter.install();
  expect(reloads).toHaveLength(0);
  expect(store.install).toBe('idle');
  expect(store.failure).toBe(UpdatesStrings.restartTookTooLong());
});

test('a platform that cannot replace itself is offered the download instead', async () => {
  const { store, presenter } = open();
  updatesApi.get = () => Promise.resolve(status('0.1.0', ['0.2.0'], false));
  await presenter.check();
  expect(store.canInstall).toBe(false);
  expect(store.installHint).toBe('https://example.invalid/Bowerbird.AppImage');
});

test('a newer model is offered, and downloaded only once the reader agrees', async () => {
  const { store, presenter, confirm, asked } = open();
  updatesApi.get = () => Promise.resolve(status('0.2.0', []));
  modelsApi.get = () => Promise.resolve(models('newer'));
  await presenter.check();
  expect(store.modelAvailable?.revision).toBe('newer');

  let downloads = 0;
  modelsApi.download = () => {
    downloads += 1;
    return Promise.resolve(models(null, true));
  };

  const declined = presenter.downloadModel();
  expect(asked.request?.title).toBe(UpdatesStrings.modelUpdateTitle());
  expect(asked.request?.body).toBe(UpdatesStrings.modelUpdateBody('7.9 MB'));
  confirm.answer(false);
  await declined;
  expect(downloads).toBe(0);

  const agreed = presenter.downloadModel();
  confirm.answer(true);
  await agreed;
  expect(downloads).toBe(1);
  expect(store.modelAvailable).toBeNull();
  expect(store.models?.upscaler.current.downloaded).toBe(true);
  expect(store.modelDownloading).toBe(false);
});

test('a model download that fails is recorded and can be tried again', async () => {
  const { store, presenter, confirm } = open();
  updatesApi.get = () => Promise.resolve(status('0.2.0', []));
  modelsApi.get = () => Promise.resolve(models('newer'));
  await presenter.check();
  modelsApi.download = () => Promise.reject(new Error('upscaler.bin does not match'));

  const downloading = presenter.downloadModel();
  confirm.answer(true);
  await downloading;
  expect(store.modelFailure).toBe('upscaler.bin does not match');
  expect(store.modelDownloading).toBe(false);
  expect(store.modelAvailable?.revision).toBe('newer');
});

test('the strings name the version, because that is the whole of the badge', () => {
  expect(UpdatesStrings.updateAvailable('0.2.0')).toContain('0.2.0');
});
