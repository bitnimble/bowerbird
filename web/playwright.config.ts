import { defineConfig } from '@playwright/test';
import { API_PORT, API_URL, DATA_DIR, DB_PATH, WEB_PORT, prepareFixture } from './e2e/fixture_library';
import { PathSegment, route } from '../src/schemas/route';

prepareFixture();

// Drives the real stack: the Hono API (which needs LibRaw for RAW decoding) and
// the Vite dev server, both on their own random ports so neither a dev session
// nor another checkout's run is disturbed.
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // **Five seconds by default, and anything slower says so at the call site.** Almost
  // everything here is a class toggling or a route resolving, which either happens in
  // milliseconds or is broken - and waiting fifteen seconds to be told that turned a failing
  // suite into a five-minute one. What genuinely takes longer is a decode, a rendition build
  // or a scan, and those are few enough to carry their own timeout where they are awaited.
  expect: { timeout: 5_000 },
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    // The same bound on the gestures, for the same reason: a click that cannot land is a
    // broken test, not a slow one.
    actionTimeout: 5_000,
    // The editor's tick is WebGPU now, and headless Chromium ships with it off and no GPU
    // process. Without these the editor reports "this browser has no WebGPU" and every
    // editing test fails for a reason that has nothing to do with the app.
    launchOptions: {
      args: [
        '--no-sandbox',
        '--enable-unsafe-webgpu',
        '--enable-gpu',
        '--ignore-gpu-blocklist',
        '--enable-features=Vulkan',
        '--use-angle=vulkan',
        '--ozone-platform=headless',
      ],
    },
  },
  // One engine for the app's behaviour, and a second for the two files whose risk is the
  // engine itself. A whole suite in both would double the run for that much.
  //
  // `grid/bands` because aspect ratios against stretched grid rows and capped flex lines
  // are where the two disagree, and a band of photographs is all three at once.
  // `editor/raw_editing` does not run there: the editor needs WebGPU, which Gecko ships on
  // Windows first, so a Linux run would assert against an engine that cannot open the
  // editor at all. What it used to cover - the three sinks, the rewrap, the thread pool -
  // went with the routes (`docs/raw-edit-gpu.md` §7).
  projects: [
    { name: 'onboarded', testMatch: /onboarded\.setup\.ts/ },
    { name: 'chromium', use: { browserName: 'chromium' }, dependencies: ['onboarded'] },
    {
      name: 'firefox',
      use: { browserName: 'firefox' },
      testMatch: /grid\/bands\.spec\.ts/,
      dependencies: ['onboarded'],
    },
  ],
  webServer: [
    {
      command: 'bun run src/index.ts',
      cwd: '..',
      url: `${API_URL}${route(PathSegment.api(), PathSegment.libraries())}`,
      reuseExistingServer: false,
      // The three that are still environment (§15); the run's DB starts empty, so
      // every setting is its default.
      //
      // Plus the one that turns update checking off (§23.5). Not tidiness: left on, every
      // spec's sidebar grows a row the moment a release exists that is newer than whatever
      // `package.json` says here, and the suite would start depending on what is published.
      env: { DB_PATH, DATA_DIR, PORT: String(API_PORT), HOST: '127.0.0.1', BOWERBIRD_UPDATE_REPO: '' },
    },
    {
      command: `bun run ../scripts/vite.ts --port ${WEB_PORT} --strictPort`,
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      // The proxy target: the browser only ever talks to the Vite server.
      env: { VITE_API_URL: API_URL },
    },
  ],
});
