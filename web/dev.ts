// Vite picks a random port when it is not given one (`vite.config.ts`), which is what lets
// several of these run side by side. A caller that has told something else where to look has
// to say the port here too: `src-tauri/tauri.conf.json` points the webview at 5199 and starts
// this with `--port 5199` for exactly that reason, and without the second half `tauri dev`
// polls a port nothing is listening on and gives up before opening a window.

// Vite's CLI is strict and only knows --port, so rewrite -p before handing over.
process.argv = process.argv.map((arg) => (arg === '-p' ? '--port' : arg));
// An asked-for port that silently moves is worse than a failure.
if (process.argv.includes('--port')) process.argv.push('--strictPort');
// vite's exports map hides bin/, so resolve it off the package.json it does export.
await import(new URL('bin/vite.js', import.meta.resolve('vite/package.json')).href);

