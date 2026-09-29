import { afterAll, afterEach, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FrameTvTokens } from '../frame_tv_tokens';

const directory = mkdtempSync(path.join(tmpdir(), 'frame-tv-tokens-'));
const file = path.join(directory, 'tokens.json');

afterEach(() => rmSync(file, { force: true }));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it('keeps a token per TV across instances', () => {
  new FrameTvTokens(file).set('uuid:living', 'a');
  new FrameTvTokens(file).set('uuid:bedroom', 'b');

  const tokens = new FrameTvTokens(file);
  expect([tokens.get('uuid:living'), tokens.get('uuid:bedroom')]).toEqual(['a', 'b']);
});

it('has no token before any TV has paired', () => {
  expect(new FrameTvTokens(file).get('uuid:living')).toBeUndefined();
});

it('starts again from a file it cannot read, rather than failing the send', () => {
  writeFileSync(file, '{not json');
  const tokens = new FrameTvTokens(file);

  expect(tokens.get('uuid:living')).toBeUndefined();
  tokens.set('uuid:living', 'a');
  expect(tokens.get('uuid:living')).toBe('a');
});
