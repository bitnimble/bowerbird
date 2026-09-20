import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PathSegment, route } from '../../src/schemas/route';
import { API_PORT, API_URL, DATA_DIR, DB_PATH, WEB_PORT, prepareState } from './shots_state';

prepareState();

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

export default defineConfig({
  testDir: '.',
  testMatch: 'screenshots.spec.ts',
  outputDir: path.join(tmpdir(), 'bowerbird-landing-shots-results'),
  workers: 1,
  timeout: 1_200_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
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
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: [
    {
      command: 'bun run src/index.ts',
      cwd: REPO,
      url: `${API_URL}${route(PathSegment.api(), PathSegment.libraries())}`,
      reuseExistingServer: false,
      env: { DB_PATH, DATA_DIR, PORT: String(API_PORT), HOST: '127.0.0.1', BOWERBIRD_UPDATE_REPO: '', LOG_LEVEL: 'warn' },
    },
    {
      command: `bun run ../scripts/vite.ts --port ${WEB_PORT} --strictPort`,
      cwd: path.join(REPO, 'web'),
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { VITE_API_URL: API_URL },
    },
  ],
});
