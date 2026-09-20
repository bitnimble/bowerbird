import path from 'node:path';

// Where a worker's code actually is, which is not the same question in a source
// tree as in a shipped app.
//
// Running from source, it is the file next to the one asking - `new URL(...,
// import.meta.url)`, as it has always been. Shipped, the server is a bundle of
// plain `.js` beside the desktop app's resources, and the shell says where
// (`BOWERBIRD_WORKER_DIR`).
//
// Asked rather than inferred because Bun's `--compile` cannot carry a worker at
// all: the minimal documented case fails the same way this app did, with
// `ModuleNotFound resolving /$bunfs/root/<name>.ts` at the moment the first
// worker starts. A server that starts perfectly and then cannot read a single
// header is worse than one that will not start, so the path is stated rather
// than left to a bundler to notice.
export function workerEntry(name: string, fromSource: URL): string | URL {
  const shipped = process.env.BOWERBIRD_WORKER_DIR;
  return shipped == null ? fromSource : path.join(shipped, `${name}.js`);
}
