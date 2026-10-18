import { join } from 'node:path';

export const APP_BINARY = join(import.meta.dirname, '..', 'src-tauri', 'target', 'debug', 'app');

export const CDP_URL = 'http://127.0.0.1:9222';

// The shell is CEF on Linux and WebView2 elsewhere, so the binary under test is a Chromium
// either way and takes Chromium's own switches - no in-process WebDriver plugin. The one
// difference from a shipped build is the `e2e` feature, without which CEF ignores them.
//
// Only what the suite itself needs: any switch the app needs to work belongs in the shell's own
// runtime config, or the suite passes against a build users cannot run.
export const SHELL_ARGS = ['--remote-debugging-port=9222', '--no-sandbox'];
