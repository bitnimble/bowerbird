// What this build calls itself, which is what an update check compares against.
//
// `package.json` is the one place a version is written by hand; `scripts/set-version.ts`
// copies it into the manifests cargo and tauri read. Imported rather than read at
// startup because the sidecar ships as a bundle with no `package.json` beside it, and
// `bun build` inlines a JSON import.
import manifest from '../package.json';

export const VERSION: string = manifest.version;
