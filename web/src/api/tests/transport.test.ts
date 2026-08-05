// The two transports have to agree, and the places they quietly did not.
import { afterEach, describe, expect, test } from 'bun:test';
import { assetUrl, subscribeEvents } from '../transport';

type Internals = {
  convertFileSrc?: (file: string, protocol: string) => string;
  invoke?: (command: string, args: unknown) => Promise<unknown>;
};
type Listen = (event: string, handler: (message: { payload: unknown }) => void) => Promise<() => void>;
const global = globalThis as {
  __TAURI_INTERNALS__?: Internals;
  __TAURI__?: { core?: { invoke?: (command: string, args: unknown) => Promise<unknown> }; event?: { listen?: Listen } };
};

afterEach(() => {
  delete global.__TAURI_INTERNALS__;
  delete global.__TAURI__;
});

/** What `tauri/scripts/core.js` emits, verbatim, for each platform it distinguishes. */
function shell(osName: 'windows' | 'android' | 'macos'): void {
  global.__TAURI_INTERNALS__ = {
    convertFileSrc: (file, protocol) =>
      osName === 'windows' || osName === 'android'
        ? `http://${protocol}.localhost/${encodeURIComponent(file)}`
        : `${protocol}://localhost/${encodeURIComponent(file)}`,
  };
}

describe('assetUrl', () => {
  test('is the path itself in a browser', () => {
    expect(assetUrl('/image/abc/renditions/grid')).toBe('/image/abc/renditions/grid');
  });

  // The bug this exists for: the prefix was hardcoded to the macOS and Linux form, so on the
  // two platforms this branch added builds for, every rendition, download and event stream
  // resolved to a scheme the webview has no handler for.
  test.each([
    ['macos', 'bowerbird://localhost/image/abc/renditions/grid'],
    ['windows', 'http://bowerbird.localhost/image/abc/renditions/grid'],
    ['android', 'http://bowerbird.localhost/image/abc/renditions/grid'],
  ] as const)('follows the platform: %s', (osName, expected) => {
    shell(osName);
    expect(assetUrl('/image/abc/renditions/grid')).toBe(expected);
  });

  // It is handed the empty string precisely because it percent-encodes what it is given, so
  // a path passed through it would come back with its slashes escaped.
  test('does not let the helper encode our path', () => {
    shell('windows');
    expect(assetUrl('/api/events')).toBe('http://bowerbird.localhost/api/events');
  });

  test('falls back to the bare path where the helper is absent', () => {
    global.__TAURI_INTERNALS__ = {};
    expect(assetUrl('/api/events')).toBe('/api/events');
  });
});

describe('subscribeEvents over IPC', () => {
  /** What `events_following` answers with when the stream is up. */
  const LIBRARY = 'http://127.0.0.1:3000';

  /** Stands in for the shell, holding whatever the page registered. */
  function shellEvents(following: string | null = null): {
    deliver: (payload: unknown) => void;
    channel: () => string;
    unlistened: () => number;
    settled: () => Promise<void>;
  } {
    let handler: ((message: { payload: unknown }) => void) | null = null;
    let channel = '';
    let unlistened = 0;
    let landed: () => void = () => {};
    const registered = new Promise<void>((resolve) => (landed = resolve));

    global.__TAURI__ = {
      // `events_following` answers with the library it is streaming from, or null.
      core: { invoke: async () => following },
      event: {
        listen: async (event, given) => {
          channel = event;
          handler = given;
          landed();
          return () => {
            unlistened += 1;
          };
        },
      },
    };
    return {
      deliver: (payload) => handler?.({ payload }),
      channel: () => channel,
      unlistened: () => unlistened,
      // The listen round trip and the state query resolve on their own microtask chains, so
      // this drains rather than counting ticks and hoping.
      settled: async () => {
        await registered;
        for (let tick = 0; tick < 8; tick++) await Promise.resolve();
      },
    };
  }

  test('routes each kind to its handler', async () => {
    const shell = shellEvents();
    const seen: string[] = [];
    subscribeEvents({
      open: () => seen.push('open'),
      rendition: (data) => seen.push(`rendition:${data}`),
    });
    await shell.settled();

    expect(shell.channel()).toBe('library:event');
    shell.deliver({ kind: 'open', data: '' });
    shell.deliver({ kind: 'rendition', data: '{"id":"a"}' });
    // A kind the page does not know is ignored rather than thrown on, so a newer shell
    // emitting a second event type does not break an older page.
    shell.deliver({ kind: 'something-later', data: 'x' });
    expect(seen).toEqual(['open', 'rendition:{"id":"a"}']);
  });

  test('stops listening once closed', async () => {
    const shell = shellEvents();
    const stream = subscribeEvents({ open: () => {}, rendition: () => {} });
    await shell.settled();

    stream.close();
    expect(shell.unlistened()).toBe(1);
  });

  // `listen` resolves after a round trip, so a view that mounts and unmounts inside it would
  // otherwise leave its handler registered for the life of the app.
  test('unlistens a subscription closed before it was registered', async () => {
    const shell = shellEvents();
    subscribeEvents({ open: () => {}, rendition: () => {} }).close();
    await shell.settled();
    expect(shell.unlistened()).toBe(1);
  });

  // The stream is the app's and connects at startup, so by the time a page subscribes its
  // `open` has already been emitted to nobody. Without asking, `serverReachable` would never
  // run for that session - which a browser never suffers, because there the page owns the
  // connection and gets its own `open`.
  test('opens for a page that subscribed after the stream was already up', async () => {
    const shell = shellEvents(LIBRARY);
    let opens = 0;
    subscribeEvents({ open: () => (opens += 1), rendition: () => {} });
    await shell.settled();
    expect(opens).toBe(1);
  });

  test('does not open where the stream is down', async () => {
    const shell = shellEvents(null);
    let opens = 0;
    subscribeEvents({ open: () => (opens += 1), rendition: () => {} });
    await shell.settled();
    expect(opens).toBe(0);
  });

  // Which kind of open it is, not merely that one happened, because the two mean opposite
  // things to a view. A stream already up when the page subscribed is the baseline it was
  // rendered against; one that comes up after is a library that was unreachable and now is
  // not - and in the shell that is the ordinary case, since the page renders from its
  // embedded bundle whether or not the library is running.
  test('says the baseline is not a reconnect', async () => {
    const shell = shellEvents(LIBRARY);
    const opens: boolean[] = [];
    subscribeEvents({ open: (reconnect) => opens.push(reconnect), rendition: () => {} });
    await shell.settled();
    expect(opens).toEqual([false]);

    shell.deliver({ kind: 'open', data: '' });
    expect(opens).toEqual([false, true]);
  });

  // The regression: launched against a library that was not running, the page's first open is
  // a server becoming reachable. Reported as a first connect, `serverReachable` never ran and
  // every thumbnail that failed while the library was down stayed a placeholder for the life
  // of the page.
  test('says a stream that comes up later is a reconnect', async () => {
    const shell = shellEvents(null);
    const opens: boolean[] = [];
    subscribeEvents({ open: (reconnect) => opens.push(reconnect), rendition: () => {} });
    await shell.settled();
    expect(opens).toEqual([]);

    shell.deliver({ kind: 'open', data: '' });
    expect(opens).toEqual([true]);
  });

  // Once for the state it asked for, then again for each reconnect, and never twice for one
  // connection - `serverReachable` re-asks every view holding a dead request.
  test('opens once per connection, and again on a reconnect', async () => {
    const shell = shellEvents(LIBRARY);
    let opens = 0;
    subscribeEvents({ open: () => (opens += 1), rendition: () => {} });
    await shell.settled();
    expect(opens).toBe(1);

    shell.deliver({ kind: 'open', data: '' });
    expect(opens).toBe(2);
    shell.deliver({ kind: 'rendition', data: '{}' });
    expect(opens).toBe(2);
    shell.deliver({ kind: 'open', data: '' });
    expect(opens).toBe(3);
  });
});
