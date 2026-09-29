import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const CLAUDE = {
  answering: `#!/bin/sh
cat > "$(dirname "$0")/input"
echo '{"structured_output":{"new":["Shows a thing."],"improved":[],"fixed":["Ratings save every time"]}}'
`,
  failing: '#!/bin/sh\nexit 1\n',
  empty: `#!/bin/sh\necho '{"structured_output":{"new":[],"improved":[],"fixed":[]}}'\n`,
  malformed: `#!/bin/sh\necho '{"structured_output":{"new":[1]}}'\n`,
};

test.each([
  ['main', 'answering'],
  ['main', 'failing'],
  ['main', 'empty'],
  ['main', 'malformed'],
  ['feature', 'answering'],
  ['detached', 'answering'],
] as const)('release from %s with claude %s', (branch, claude) => {
  const root = mkdtempSync(join(tmpdir(), 'bb-release-'));
  const bin = mkdtempSync(join(tmpdir(), 'bb-release-bin-'));
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    writeFileSync(join(bin, 'claude'), CLAUDE[claude], { mode: 0o755 });
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src'));
    for (const file of [
      'scripts/release.ts',
      'scripts/changelog.ts',
      'src/version.ts',
      'COPYWRITING.md',
    ]) {
      copyFileSync(join(import.meta.dir, '..', file), join(root, file));
    }
    writeFileSync(join(root, 'VERSION'), '1.2.3\n');
    writeFileSync(join(root, 'changelog.json'), '{}\n');
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Release test');
    git('config', 'user.email', 'release@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    git('add', '.');
    git('commit', '-m', 'Initial version');
    git('tag', '--annotate', 'v1.2.3', '-m', 'v1.2.3');
    git('commit', '--allow-empty', '-m', 'feat: a thing');
    if (branch === 'feature') git('switch', '-c', branch);
    if (branch === 'detached') git('switch', '--detach');
    const head = git('rev-parse', 'HEAD');
    const result = spawnSync(process.execPath, ['scripts/release.ts'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });

    if (branch === 'main') {
      expect(result.status).toBe(0);
      expect(readFileSync(join(root, 'VERSION'), 'utf8')).toBe('1.2.4\n');
      expect(JSON.parse(readFileSync(join(root, 'changelog.json'), 'utf8'))).toEqual({
        'v1.2.4':
          claude === 'answering'
            ? '### New\n\n- Shows a thing\n\n### Fixed\n\n- Ratings save every time'
            : 'Bug fixes and performance improvements',
      });
      if (claude === 'answering') {
        const input = readFileSync(join(bin, 'input'), 'utf8');
        expect(input).toContain('feat: a thing');
        expect(input).not.toContain('Initial version');
      }
      expect(git('rev-parse', 'v1.2.4^{}')).toBe(git('rev-parse', 'HEAD'));
      expect(git('log', '-1', '--format=%s')).toBe('chore(release): 1.2.4');
      expect(git('show', '--name-only', '--format=', 'HEAD')).toBe('VERSION\nchangelog.json');
    } else {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('releases must be cut on main');
      expect(readFileSync(join(root, 'VERSION'), 'utf8')).toBe('1.2.3\n');
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('tag', '--list')).toBe('v1.2.3');
    }
    expect(git('status', '--porcelain')).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test('release planning refuses a failed remote tag lookup', () => {
  const workflow = z
    .object({
      jobs: z.object({
        plan: z.object({
          steps: z.array(z.object({ id: z.string().optional(), run: z.string().optional() })),
        }),
      }),
    })
    .parse(
      Bun.YAML.parse(
        readFileSync(join(import.meta.dir, '../.github/workflows/release.yml'), 'utf8'),
      ),
    );
  const script = workflow.jobs.plan.steps.find((step) => step.id === 'tag')?.run;
  if (script == null) throw new Error('Release planning has no tag step');
  const root = mkdtempSync(join(tmpdir(), 'bb-release-tag-'));
  try {
    writeFileSync(join(root, 'VERSION'), '1.2.3\n');
    const output = join(root, 'output');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-e', '-c', script], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_SHA: '1234567', GITHUB_OUTPUT: output },
    });
    expect(result.status).not.toBe(0);
    expect(existsSync(output)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
