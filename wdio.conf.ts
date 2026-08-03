import { join } from 'node:path';

// Drives the REAL desktop binary and the webview it embeds, which is the one thing the
// Chromium Playwright suite cannot cover: the editor's open runs in this process now
// (`src-tauri/src/edit.rs`), and IPC is the seam Playwright has to stub.
//
// The embedded driver provider runs a W3C WebDriver server inside the app
// (tauri-plugin-wdio-webdriver), so no system WebKitWebDriver or tauri-driver is needed.
// On a headless box the webview still needs a display: `xvfb-run -a bun run e2e:tauri`.
//
// Build the binary first with `bun run e2e:tauri:build`, or `bun run e2e:tauri`, which
// chains both. Specs live in `e2e-tauri/*.wdio.ts`, a suffix neither the Playwright
// `**/*.spec.ts` runner nor `bun test` picks up.
const APP_BINARY = join(import.meta.dirname, 'src-tauri', 'target', 'debug', 'app');

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: ['./e2e-tauri/*.wdio.ts'],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'tauri',
      'tauri:options': { application: APP_BINARY },
    },
  ],
  services: [['@wdio/tauri-service', { driverProvider: 'embedded' }]],
  framework: 'mocha',
  reporters: ['spec'],
  // The open is a real LibRaw decode plus a camera fit, which is seconds.
  mochaOpts: { ui: 'bdd', timeout: 120_000 },
  logLevel: 'warn',
};
