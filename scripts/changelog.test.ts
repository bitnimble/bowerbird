import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLAUDE = `#!/bin/sh
cat > "$(dirname "$0")/input"
echo '{"structured_output":{"new":["Straighten photos"],"improved":[],"fixed":[]}}'
`;

test('commits from a merged branch reach claude grouped under its merge', () => {
  const root = mkdtempSync(join(tmpdir(), 'bb-changelog-'));
  const bin = mkdtempSync(join(tmpdir(), 'bb-changelog-bin-'));
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    writeFileSync(join(bin, 'claude'), CLAUDE, { mode: 0o755 });
    mkdirSync(join(root, 'scripts'));
    for (const file of ['scripts/changelog.ts', 'COPYWRITING.md']) {
      copyFileSync(join(import.meta.dir, '..', file), join(root, file));
    }
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Changelog test');
    git('config', 'user.email', 'changelog@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    git('add', '.');
    git('commit', '-m', 'Initial version');
    git('tag', 'v1');
    git('commit', '--allow-empty', '-m', 'fix: ratings save every time');
    git('switch', '-c', 'feat/straighten');
    git('commit', '--allow-empty', '-m', 'feat: straighten tool');
    git('commit', '--allow-empty', '-m', 'fix: straighten guide snaps');
    git('switch', 'main');
    git('commit', '--allow-empty', '-m', 'feat: export JXL');
    git('merge', '--no-ff', '-m', "Merge branch 'feat/straighten'", 'feat/straighten');

    const result = spawnSync(process.execPath, ['scripts/changelog.ts', 'v1', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    expect(result.stdout).toBe('### New\n\n- Straighten photos\n');
    const input = readFileSync(join(bin, 'input'), 'utf8').replace(/\b[0-9a-f]{7,}\b/g, 'HASH');
    expect(input).toBe(
      [
        '<branch>',
        'merge HASH',
        "Merge branch 'feat/straighten'",
        '',
        'commit HASH',
        'fix: straighten guide snaps',
        '',
        'commit HASH',
        'feat: straighten tool',
        '</branch>',
        '',
        'commit HASH',
        'feat: export JXL',
        '',
        'commit HASH',
        'fix: ratings save every time',
      ].join('\n'),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
