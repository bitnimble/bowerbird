import { join } from 'node:path';

export const APP_BINARY = join(import.meta.dirname, '..', 'src-tauri', 'target', 'debug', 'app');

export const CDP_URL = 'http://127.0.0.1:9222';

// The shell is CEF on Linux and WebView2 elsewhere, so the binary under test is a Chromium
// either way and takes Chromium's own switches - no in-process WebDriver plugin, and nothing
// compiled into the build that a shipped one does not also have.
//
// `--remote-debugging-port` is what the suite attaches to. The rest mirror
// `web/playwright.config.ts`: the editor's tick is WebGPU, and a headless Chromium starts
// with it off and no GPU process, so without them the WebGPU specimen fails for the
// environment's reasons rather than the shell's.
export const SHELL_ARGS = [
  '--remote-debugging-port=9222',
  '--no-sandbox',
  '--enable-unsafe-webgpu',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--enable-features=Vulkan',
  '--use-angle=vulkan',
];
