// The editor's open is the one request the desktop shell parses rather than proxies, so its
// path format is encoded twice: `preparedPath` builds it here and `edit::parse` takes it apart
// in `src-tauri/src/edit.rs`. The only place the two meet at runtime is the desktop e2e, which
// writes the path out by hand rather than asking for it - so renaming the query parameter on
// this side would go on passing while every open in the app fell back to `long_edge = 0`,
// which is a whole-sensor decode nobody asked for.
//
// The shell's own literals, read out of it, against the string this actually builds.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { preparedPath } from '../client';

const SHELL = join(import.meta.dir, '..', '..', '..', '..', 'src-tauri', 'src', 'edit.rs');

function shell(): string {
  return readFileSync(SHELL, 'utf8');
}

function only(pattern: RegExp): string {
  const found = pattern.exec(shell());
  expect(found, `src-tauri/src/edit.rs no longer contains ${pattern}`).not.toBeNull();
  return found?.[1] ?? '';
}

describe('the prepared path', () => {
  test('is built the way the shell takes it apart', () => {
    const [route, query] = preparedPath('a-photo-id', 4096).split('?');
    const prefix = only(/strip_prefix\("(\/[^"]+)"\)/);
    const suffix = only(/strip_suffix\("([^"]+)"\)/);
    const parameter = only(/strip_prefix\("([a-zA-Z]+=)"\)/);

    expect(route?.startsWith(prefix), `${route} does not start with ${prefix}`).toBe(true);
    expect(route?.endsWith(suffix), `${route} does not end with ${suffix}`).toBe(true);
    expect(query?.startsWith(parameter), `${query} does not start with ${parameter}`).toBe(true);
  });

  test('rounds the size to something the shell can parse as a u32', () => {
    expect(preparedPath('a-photo-id', 4096.7)).toBe('/image/a-photo-id/prepared?longEdge=4097');
    expect(shell()).toContain('parse::<u32>()');
  });
});
