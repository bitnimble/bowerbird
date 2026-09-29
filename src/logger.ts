// Every server log line goes through here (DESIGN §14.3), and every page one through
// `web/src/features/logs/page_log.ts`; oxlint's `no-console` keeps it that way.

import { closeSync, existsSync, openSync, renameSync, writeSync } from 'node:fs';
import { isMainThread } from 'node:worker_threads';
import { z } from 'zod';
import { LOG_LEVELS, LogLevelSchema, type LogLevel } from './schemas/settings';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// The floor every Logger writes against, a setting in the database (§15) applied
// at startup and again on edit. `LOG_LEVEL` pins it and wins: logging starts
// before the database is open, and a server that will not boot cannot be turned
// up from its own settings page.
const override = LOG_LEVELS.find((level) => level === process.env.LOG_LEVEL) ?? null;
let minimumLevel: LogLevel = override ?? 'info';

// A worker loads its own copy of this module: its lines cross to the main thread's output, and
// the main thread's level crosses back.
const ThreadMessageSchema = z.union([
  z.object({ line: z.string() }),
  z.object({ level: LogLevelSchema }),
  z.object({ askLevel: z.literal(true) }),
]);
type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

const threads = new BroadcastChannel('bowerbird-log');
// Undeclared in Bun's types; without it a script importing this never exits.
if ('unref' in threads && typeof threads.unref === 'function') threads.unref();
threads.onmessage = (event) => {
  const parsed = ThreadMessageSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;
  if (isMainThread && 'line' in message) logOutput.record(message.line);
  if (isMainThread && 'askLevel' in message) tell({ level: minimumLevel });
  if (!isMainThread && 'level' in message && override == null) minimumLevel = message.level;
};
if (!isMainThread) tell({ askLevel: true });

function tell(message: ThreadMessage): void {
  threads.postMessage(message);
}

export function setLogLevel(level: LogLevel): void {
  if (override != null) return;
  minimumLevel = level;
  tell({ level });
}

const RECENT_LINES_KEPT = 2000;
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;

interface LogFile {
  path: string;
  fd: number;
  bytes: number;
}

export class LogOutput {
  private readonly lines: string[] = [];
  private file: LogFile | null = null;

  recent(): readonly string[] {
    return this.lines;
  }

  /** Moves any earlier run's file to `<path>.1`, as it does whenever this one outgrows its cap. */
  toFile(filePath: string): void {
    this.close();
    this.file = { path: filePath, fd: openFresh(filePath), bytes: 0 };
  }

  close(): void {
    if (this.file == null) return;
    closeSync(this.file.fd);
    this.file = null;
  }

  record(line: string): void {
    this.lines.push(line);
    if (this.lines.length > RECENT_LINES_KEPT) this.lines.shift();
    if (this.file == null) return;
    const { path } = this.file;
    const bytes = Buffer.from(`${line}\n`);
    try {
      if (this.file.bytes + bytes.length > LOG_FILE_MAX_BYTES) this.toFile(path);
      // Synchronous, so an uncaught error's line is on disk before the process exits.
      writeSync(this.file.fd, bytes);
      this.file.bytes += bytes.length;
    } catch (err) {
      // A full or vanished disk must not take every caller that logs down with it.
      console.error(`stopped writing ${path}: ${String(err)}`);
      try {
        this.close();
      } catch {
        this.file = null;
      }
    }
  }
}

function openFresh(filePath: string): number {
  if (existsSync(filePath)) renameSync(filePath, `${filePath}.1`);
  return openSync(filePath, 'w');
}

export const logOutput = new LogOutput();

function keep(line: string): void {
  if (isMainThread) logOutput.record(line);
  else tell({ line });
}

export type Fields = Record<string, unknown>;

function quote(value: string): string {
  return value === '' || /[\s"]/.test(value) ? JSON.stringify(value) : value;
}

// An Error renders as its message: a call site passing the error it caught is
// the common case, and `[object Object]` helps nobody.
function renderValue(value: unknown): string {
  if (value instanceof Error) return quote(value.message);
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'object') return quote(JSON.stringify(value));
  return String(value);
}

export function format(level: LogLevel, scope: string, message: string, fields?: Fields): string {
  const parts = [new Date().toISOString(), level.toUpperCase().padEnd(5), `[${scope}]`, message];
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value == null) continue;
    parts.push(`${key}=${renderValue(value)}`);
  }
  return parts.join(' ');
}

// The stack of whichever error was passed in, kept for the level that is about
// something nobody expected: a message alone rarely says which call raised it.
function stackOf(fields?: Fields): string | null {
  for (const value of Object.values(fields ?? {})) {
    if (value instanceof Error && value.stack != null) return value.stack;
  }
  return null;
}

export class Logger {
  constructor(
    private readonly scope: string,
    // Read per line rather than captured, because a Logger is built at import
    // time and the level it should obey is only known once the database is open.
    private readonly minimum?: LogLevel,
  ) {}

  debug(message: string, fields?: Fields): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Fields): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Fields): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Fields): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Fields): void {
    if (SEVERITY[level] < SEVERITY[this.minimum ?? minimumLevel]) return;
    const line = format(level, this.scope, message, fields);
    if (SEVERITY[level] < SEVERITY.warn) {
      keep(line);
      console.log(line);
      return;
    }
    // warn and error go to stderr, so a shell can keep them apart from the
    // running commentary.
    const trace = level === 'error' ? stackOf(fields) : null;
    const traced = trace == null ? line : `${line}\n${trace}`;
    keep(traced);
    console.error(traced);
  }
}
