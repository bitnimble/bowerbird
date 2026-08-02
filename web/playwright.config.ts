import { defineConfig } from '@playwright/test';
import { API_PORT, API_URL, DB_PATH, WEB_PORT, prepareFixture } from './e2e/fixture_library';

prepareFixture();

// Drives the real stack: the Hono API (which needs LibRaw for RAW decoding) and
// the Vite dev server, both on their own random ports so neither a dev session
// nor another checkout's run is disturbed.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: 'retain-on-failure' },
  // One engine for the app's behaviour, and a second for the two files whose risk is the
  // engine itself. A whole suite in both would double the run for that much.
  //
  // `band_layout` because aspect ratios against stretched grid rows and capped flex lines
  // are where the two disagree, and a band of photographs is all three at once.
  // `raw_editing` because the worker, the camera match, the rewrap helper and the
  // open-failure path all have to work in Gecko (DESIGN 21.3). Painting that MP4 in HDR
  // is Windows-only (DESIGN 10.7); Linux CI asserts on the bytes, not on videoWidth.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
      testMatch: /(band_layout|raw_editing)\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: 'bun run src/index.ts',
      cwd: '..',
      url: `${API_URL}/api/libraries`,
      reuseExistingServer: false,
      // The three that are still environment (§15); the run's DB starts empty, so
      // every setting is its default.
      env: { DB_PATH, PORT: String(API_PORT), HOST: '127.0.0.1' },
    },
    {
      command: `./node_modules/.bin/vite --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      // The proxy target: the browser only ever talks to the Vite server.
      env: { VITE_API_URL: API_URL },
    },
  ],
});
