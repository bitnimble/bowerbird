import { afterEach, describe, expect, test } from 'bun:test';
import {
  appDataDir,
  canRevealFile,
  openAppDataDir,
  subscribeEvents,
  type EventHandlers,
} from '../transport';
import { PathSegment, route } from '../../../../src/schemas/route';

const global = globalThis as {
  __TAURI__?: { core?: { invoke?: (command: string, args: unknown) => Promise<unknown> } };
};

afterEach(() => {
  delete global.__TAURI__;
});

describe('the app data folder', () => {
  function shellAnswering(answer: string | null): { asked: () => string[] } {
    const asked: string[] = [];
    global.__TAURI__ = {
      core: {
        invoke: async (command) => {
          asked.push(command);
          return answer;
        },
      },
    };
    return { asked: () => asked };
  }

  test('is nothing in a browser, which has no shell to ask', async () => {
    expect(await appDataDir()).toBeNull();
    expect(await openAppDataDir()).toBeUndefined();
  });

  test('is what the shell answers', async () => {
    const shell = shellAnswering('/home/reader/.local/share/dev.kumo.bowerbird');
    expect(await appDataDir()).toBe('/home/reader/.local/share/dev.kumo.bowerbird');
    await openAppDataDir();
    expect(shell.asked()).toEqual(['app_data_dir', 'open_app_data_dir']);
  });

  // The mobile app: the folder is app-private, so the shell offers no path and the settings page
  // renders no row rather than a button that opens nothing.
  test('is nothing where the shell says there is nowhere to open', async () => {
    shellAnswering(null);
    expect(await appDataDir()).toBeNull();
  });
});

describe('showing a file in its folder', () => {
  const userAgent = navigator.userAgent;
  const pretend = (agent: string): void => {
    Object.defineProperty(navigator, 'userAgent', { value: agent, configurable: true });
  };
  afterEach(() => pretend(userAgent));

  test('is offered by a desktop shell, and by neither a browser nor the mobile app', () => {
    pretend('Mozilla/5.0 (X11; Linux x86_64)');
    expect(canRevealFile()).toBe(false);

    global.__TAURI__ = { core: { invoke: async () => null } };
    expect(canRevealFile()).toBe(true);

    for (const phone of [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8)',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    ]) {
      pretend(phone);
      expect(canRevealFile()).toBe(false);
    }
  });

  test('tells an iPad from the Mac its webview claims to be', () => {
    const touchPoints = navigator.maxTouchPoints;
    const touch = (points: number): void => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: points, configurable: true });
    };
    try {
      global.__TAURI__ = { core: { invoke: async () => null } };
      pretend('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15');
      touch(0);
      expect(canRevealFile()).toBe(true);
      touch(5);
      expect(canRevealFile()).toBe(false);
    } finally {
      touch(touchPoints);
    }
  });
});

describe('subscribeEvents', () => {
  function handlers(watching: Partial<EventHandlers> = {}): EventHandlers {
    return {
      open: () => {},
      rendition: () => {},
      rendition_fetch: () => {},
      replication: () => {},
      backup: () => {},
      composite: () => {},
      export: () => {},
      ...watching,
    };
  }

  /** Stands in for the browser's `EventSource`, holding whatever the page registered. */
  function eventSource(): {
    opened: string[];
    deliver: (kind: string, data?: string) => void;
    closed: () => boolean;
    restore: () => void;
  } {
    const real = globalThis.EventSource;
    const opened: string[] = [];
    const listeners = new Map<string, (event: { data: string }) => void>();
    let closed = false;
    globalThis.EventSource = class {
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener(kind: string, listener: (event: { data: string }) => void): void {
        listeners.set(kind, listener);
      }
      close(): void {
        closed = true;
      }
    } as unknown as typeof EventSource;
    return {
      opened,
      deliver: (kind, data = '') => listeners.get(kind)?.({ data }),
      closed: () => closed,
      restore: () => (globalThis.EventSource = real),
    };
  }

  test('routes each kind to its handler, on the page’s own connection', () => {
    const source = eventSource();
    try {
      const seen: string[] = [];
      subscribeEvents(
        handlers({
          rendition: (data) => seen.push(`rendition:${data}`),
          replication: (data) => seen.push(`replication:${data}`),
        }),
      );
      source.deliver('rendition', '{"id":"a"}');
      source.deliver('replication', '{"library_id":"lib"}');
      expect(source.opened).toEqual([route(PathSegment.api(), PathSegment.events())]);
      expect(seen).toEqual(['rendition:{"id":"a"}', 'replication:{"library_id":"lib"}']);
    } finally {
      source.restore();
    }
  });

  // A page served by the API cannot have loaded while the API was unreachable, so only the
  // connects after the first are a server coming back.
  test('says the first connect is the baseline and every later one a reconnect', () => {
    const source = eventSource();
    try {
      const opens: boolean[] = [];
      subscribeEvents(handlers({ open: (reconnect) => opens.push(reconnect) }));
      source.deliver('open');
      source.deliver('open');
      source.deliver('open');
      expect(opens).toEqual([false, true, true]);
    } finally {
      source.restore();
    }
  });

  test('closes the connection', () => {
    const source = eventSource();
    try {
      subscribeEvents(handlers()).close();
      expect(source.closed()).toBe(true);
    } finally {
      source.restore();
    }
  });
});
