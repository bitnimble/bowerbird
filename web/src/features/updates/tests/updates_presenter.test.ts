// What the page does with an update, against a recording API. The thing worth pinning
// here is the restart: the server exits as soon as it has answered, so every request
// after `apply` fails until the new version is up, and a page that reloads on the click
// reloads into nothing.
import { expect, test } from 'bun:test';
import { type UpdateStatus } from '../../../../../src/schemas/updates';
import { updatesApi } from '../../../api/updates';
import { restoreApiAfterTests } from '../../../test_api';
import { UpdatesPresenter } from '../updates_presenter';
import { UpdatesStore } from '../updates_store';
import { UpdatesStrings } from '../updates.strings';

restoreApiAfterTests();

function status(current: string, newer: string[], canInstall = true): UpdateStatus {
  return {
    current,
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
function open(): { store: UpdatesStore; presenter: UpdatesPresenter; reloads: number[] } {
  const store = new UpdatesStore();
  const reloads: number[] = [];
  const presenter = new UpdatesPresenter(store, {
    reload: () => reloads.push(Date.now()),
    pollMs: 1,
    timeoutMs: 60,
  });
  return { store, presenter, reloads };
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
  expect(store.installing).toBe(false);
  expect(store.failure).toBe('no payload for linux-x86_64');
});

// The reason the reload is not at the click: the server exits as soon as it has answered,
// so every request between the click and the supervisor starting the new version fails.
// A page reloaded into that is a blank screen with no way to tell it was ever working.
test('the page reloads only once the new version is the one answering', async () => {
  const { store, presenter, reloads } = open();
  updatesApi.get = () => Promise.resolve(status('0.1.0', ['0.2.0']));
  await presenter.check();

  let asked = 0;
  updatesApi.apply = () => Promise.resolve(status('0.1.0', ['0.2.0']));
  updatesApi.get = () => {
    asked += 1;
    // Down for the first two polls, which is the whole of the restart.
    if (asked < 3) return Promise.reject(new Error('connection refused'));
    return Promise.resolve(status('0.2.0', []));
  };

  await presenter.install();
  expect(reloads).toHaveLength(1);
  expect(asked).toBeGreaterThanOrEqual(3);
  expect(store.failure).toBeNull();
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
  expect(store.installing).toBe(false);
  expect(store.failure).toBe(UpdatesStrings.restartTookTooLong());
});

test('a platform that cannot replace itself is offered the download instead', async () => {
  const { store, presenter } = open();
  updatesApi.get = () => Promise.resolve(status('0.1.0', ['0.2.0'], false));
  await presenter.check();
  expect(store.canInstall).toBe(false);
  expect(store.installHint).toBe('https://example.invalid/Bowerbird.AppImage');
});

test('the strings name the version, because that is the whole of the badge', () => {
  expect(UpdatesStrings.updateAvailable('0.2.0')).toContain('0.2.0');
});
