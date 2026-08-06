// Where the server listens, where its database is, and where it writes the files
// it generates: the things that have to be known before the database can be
// opened. Everything else is a setting in that database, editable from the app
// (DESIGN §15).

import path from 'node:path';
import { parseArgs } from 'node:util';

// -p/--port, taking precedence over PORT so a specific port can be pinned
// without editing the environment. Not strict: the flag has to coexist with
// whatever else the runtime was invoked with.
function argPort(): number | undefined {
  const { values } = parseArgs({ options: { port: { type: 'string', short: 'p' } }, strict: false });
  if (typeof values.port !== 'string') return undefined;
  const value = Number(values.port);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Invalid -p: "${values.port}" is not a port number`);
  }
  return value;
}

// 0 means "whatever the OS hands out", so several checkouts can run their own
// server (and their own E2E run) at once. The bound port is logged at startup.
function envPort(): number {
  const raw = process.env.PORT;
  if (raw == null || raw === '') return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`Invalid PORT: "${raw}" is not a port number`);
  return value;
}

export const config = {
  port: argPort() ?? envPort(),
  host: process.env.HOST ?? '0.0.0.0',
  dbPath: process.env.DB_PATH ?? './bowerbird.db',
  // Every generated file, one subdirectory per library (§3). Resolved absolute
  // at load, so nothing downstream has to care what the working directory was.
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
} as const;
