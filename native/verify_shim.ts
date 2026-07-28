// Decides whether one of the shipped rawshim builds can run on this machine.
//
// A short-lived process on purpose, which is the whole point of the file. The
// image ships builds tuned for instruction sets the host may not have, and such a
// build dies with SIGILL - which cannot be caught. So it has to be provoked here,
// in a process whose death costs nothing, rather than inside a worker halfway
// through an import.
//
// Exits 0 if the library is usable. Anything else - a load failure, a bad answer,
// a fault - tells the entrypoint to try the next build down.
import { dlopen, FFIType } from 'bun:ffi';

const path = process.argv[2];
if (path == null) {
  console.error('usage: verify_shim.ts <path to a librawshim .so>');
  process.exit(2);
}

try {
  // bb_selftest runs the warp and the colour lookup on a small image, so the
  // vectorised code actually executes. Loading the library proves nothing on its
  // own: a symbol that returns a constant answers fine on a CPU that faults the
  // moment real pixel work starts.
  const { symbols } = dlopen(path, { bb_selftest: { args: [], returns: FFIType.i32 } });
  const status = symbols.bb_selftest();
  if (status !== 0) {
    console.error(`verify_shim: ${path} self-test returned ${status}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`verify_shim: ${path} is not usable: ${String(error)}`);
  process.exit(1);
}
