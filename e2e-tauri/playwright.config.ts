import { defineConfig } from '@playwright/test';
import { APP_BINARY, CDP_URL, SHELL_ARGS } from './shell';

// Drives the REAL desktop binary and the webview it embeds, which is the one thing the
// Chromium `web/e2e` suite cannot cover: every request the page makes crosses IPC in this
// build (`src-tauri/src/api.rs`), and IPC is the seam that suite has to stub.
//
// Attached to over CDP rather than driven through WebDriver. The shell used to carry
// `tauri-plugin-wdio` and `tauri-plugin-wdio-webdriver` to serve WebDriver from inside
// itself; both are gone, because a Chromium already speaks CDP and the plugins do not build
// against the CEF branch. What that buys beyond compiling: the binary under test is now the
// shipped configuration exactly, with no e2e-only plugin in it.
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
