import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FRESH = '1111111111111111';
export const STALE = '2222222222222222';
export const GONE = '3333333333333333';

export const A_MONTH_AGO = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;

export function file(path: string, bytes: number, seconds?: number): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes));
  if (seconds != null) utimesSync(path, seconds, seconds);
  return path;
}

export function fingerprint(profile: string, hash: string, seconds?: number, asked?: unknown): void {
  const dir = join(profile, '.fingerprint', `rawshim-${hash}`);
  mkdirSync(dir, { recursive: true });
  if (asked != null) writeFileSync(join(dir, 'lib-rawshim.json'), JSON.stringify(asked));
  file(join(dir, 'invoked.timestamp'), 0, seconds);
}
