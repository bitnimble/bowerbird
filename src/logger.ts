// Every server log line goes through here (DESIGN §14.3); oxlint's `no-console`
// keeps it that way.

import { LOG_LEVELS, type LogLevel } from './schemas/settings';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// The floor every Logger writes against, a setting in the database (§15) applied
// at startup and again on edit. `LOG_LEVEL` pins it and wins: logging starts
// before the database is open, and a server that will not boot cannot be turned
// up from its own settings page.
const override = LOG_LEVELS.find((level) => level === process.env.LOG_LEVEL) ?? null;
let minimumLevel: LogLevel = override ?? 'info';

export function setLogLevel(level: LogLevel): void {
  if (override == null) minimumLevel = level;
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
      console.log(line);
      return;
    }
    // warn and error go to stderr, so a shell can keep them apart from the
    // running commentary.
    const trace = level === 'error' ? stackOf(fields) : null;
    console.error(trace == null ? line : `${line}\n${trace}`);
  }
}
