import { afterEach, expect, test } from 'bun:test';
import { logsApi } from '../../../api/logs';
import { restoreApiAfterTests } from '../../../test_api';
import { serverLog } from '../server_log';

restoreApiAfterTests();

const shell = globalThis as { __TAURI__?: unknown };
afterEach(() => delete shell.__TAURI__);

function inApp(file: string[]): string[] {
  const asked: string[] = [];
  shell.__TAURI__ = {
    core: {
      invoke: async (command: string) => {
        asked.push(command);
        return file;
      },
    },
  };
  return asked;
}

test("reads the server's own answer while it gives one", async () => {
  const asked = inApp(['from the file']);
  logsApi.server = async () => ({ name: 'Phone', lines: ['from the server'] });

  expect(await serverLog(50)).toEqual({ name: 'Phone', lines: ['from the server'] });
  expect(asked).toEqual([]);
});

test("reads the app's copy of the log file when the server is too stuck to answer", async () => {
  const asked = inApp(['scan start', 'scan walked the tree']);
  logsApi.server = () => new Promise(() => {});

  expect(await serverLog(50)).toEqual({
    name: 'Server log file',
    lines: ['scan start', 'scan walked the tree'],
  });
  expect(asked).toEqual(['server_log_file']);
});

test('has nothing to show in a browser whose server does not answer', async () => {
  logsApi.server = async () => {
    throw new Error('offline');
  };

  expect(await serverLog(50)).toBeNull();
});
