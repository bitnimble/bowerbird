// Vite's CLI is strict and only knows --port, so rewrite -p before handing over.
process.argv = process.argv.map((arg) => (arg === '-p' ? '--port' : arg));
// An asked-for port that silently moves is worse than a failure.
if (process.argv.includes('--port')) process.argv.push('--strictPort');
// vite's exports map hides bin/, so resolve it off the package.json it does export.
await import(new URL('bin/vite.js', import.meta.resolve('vite/package.json')).href);

