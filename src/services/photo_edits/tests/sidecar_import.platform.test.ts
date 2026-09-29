import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sidecarFor } from '../sidecar_import';

describe('sidecarFor', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'bb-sidecar-name-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('accepts upper case, which is what a case-insensitive filesystem hands back', () => {
    writeFileSync(path.join(root, 'C.XMP'), 'sidecar');
    const found = sidecarFor(path.join(root, 'C.CR3'));
    expect(found).not.toBeNull();
    expect(readFileSync(found!, 'utf8')).toBe('sidecar');
  });
});
