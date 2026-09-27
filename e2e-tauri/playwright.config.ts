import { defineConfig } from '@playwright/test';
import { APP_BINARY, CDP_URL, SHELL_ARGS } from './shell';

// Drives the REAL desktop binary and the webview it embeds, which is the one thing the
// Chromium `web/e2e` suite cannot cover: the shell starting its own server, signing its page
// in to it, and answering the commands a page cannot (`src-tauri/src/lib.rs`).
//
// Attached to over CDP rather than driven through WebDriver: a Chromium already speaks it, so
// the binary under test is the shipped configuration exactly, with no e2e-only plugin in it.
//
// `webServer` launches the binary and waits for the CDP port to answer, then kills it. On a
// headless box the webview still needs a display, so `scripts/e2e-tauri-full.ts` wraps the
// whole run in `xvfb-run`, and the launch inherits it.
//
// Specs are `*.desktop.ts`, a suffix neither the `web/e2e` Playwright runner nor `bun test
// src` picks up.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.desktop\.ts$/,
  fullyParallel: false,
  workers: 1,
  // The open is a real LibRaw decode plus a camera fit, which is seconds.
  timeout: 120_000,
  reporter: [['list']],
  webServer: {
    command: `${APP_BINARY} ${SHELL_ARGS.join(' ')}`,
    url: `${CDP_URL}/json/version`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
