import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

test.each(['main', 'feature', 'detached'])('release from %s', (branch) => {
  const root = mkdtempSync(join(tmpdir(), 'bb-release-'));
  const git = (...args: string[]): string => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'src'));
    copyFileSync(join(import.meta.dir, 'release.ts'), join(root, 'scripts/release.ts'));
    copyFileSync(join(import.meta.dir, '../src/version.ts'), join(root, 'src/version.ts'));
    writeFileSync(join(root, 'VERSION'), '1.2.3\n');
    git('init', '--initial-branch=main');
    git('config', 'user.name', 'Release test');
    git('config', 'user.email', 'release@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    git('add', '.');
    git('commit', '-m', 'Initial version');
    if (branch === 'feature') git('switch', '-c', branch);
    if (branch === 'detached') git('switch', '--detach');
    const head = git('rev-parse', 'HEAD');
    const result = spawnSync(process.execPath, ['scripts/release.ts'], { cwd: root, encoding: 'utf8' });

    if (branch === 'main') {
      expect(result.status).toBe(0);
      expect(readFileSync(join(root, 'VERSION'), 'utf8')).toBe('1.2.4\n');
      expect(git('rev-parse', 'v1.2.4^{}')).toBe(git('rev-parse', 'HEAD'));
      expect(git('log', '-1', '--format=%s')).toBe('chore(release): 1.2.4');
    } else {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('releases must be cut on main');
      expect(readFileSync(join(root, 'VERSION'), 'utf8')).toBe('1.2.3\n');
      expect(git('rev-parse', 'HEAD')).toBe(head);
      expect(git('tag', '--list')).toBe('');
    }
    expect(git('status', '--porcelain')).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('release planning refuses a failed remote tag lookup', () => {
  const workflow = z.object({
    jobs: z.object({ plan: z.object({ steps: z.array(z.object({ id: z.string().optional(), run: z.string().optional() })) }) }),
  }).parse(Bun.YAML.parse(readFileSync(join(import.meta.dir, '../.github/workflows/release.yml'), 'utf8')));
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
