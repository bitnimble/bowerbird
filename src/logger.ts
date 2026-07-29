// Every server log line goes through here (DESIGN §14.3); oxlint's `no-console`
// keeps it that way.

import { config, type LogLevel } from './config';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

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
    private readonly minimum: LogLevel = config.logLevel,
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
    if (SEVERITY[level] < SEVERITY[this.minimum]) return;
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
