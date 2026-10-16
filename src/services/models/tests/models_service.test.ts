import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelsService, type Installed, type Model } from '../models_service';

type Files = Record<string, string>;
interface Commit {
  sha: string;
  committed_at: string;
  files: Files;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const blobOid = (text: string): string =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(text)}\0${text}`)
    .digest('hex');
/** Kept in LFS, so git holds a pointer to it rather than its bytes. */
const inLfs = (name: string): boolean => name.endsWith('.bin');
const oidOf = (name: string, text: string): string =>
  blobOid(inLfs(name) ? `pointer ${sha256(text)}` : text);

const BASE: Commit = {
  sha: 'a'.repeat(40),
  committed_at: '2026-10-01T00:00:00.000Z',
  files: { 'upscaler.json': '{"for":"bundled"}', 'upscaler.bin': 'old' },
};
const BUNDLED: Installed = {
  revision: BASE.sha,
  committed_at: BASE.committed_at,
  git_oids: Object.fromEntries(
    Object.entries(BASE.files).map(([name, text]) => [name, oidOf(name, text)]),
  ),
};
const NEWER: Commit = {
  sha: 'b'.repeat(40),
  committed_at: '2026-10-09T00:00:00.000Z',
  files: { 'upscaler.json': '{"for":"newer"}', 'upscaler.bin': 'retrained' },
};

let main = BASE;
const commits = new Map<string, Commit>();
let served = (name: string, at: Commit): string => at.files[name] ?? '';

const hub = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request): Response {
    const url = new URL(request.url).pathname;
    if (url === '/api/models/bitnimble/bowerbird/revision/main') {
      return Response.json({ sha: main.sha, lastModified: main.committed_at });
    }
    const listed = commits.get(
      /^\/api\/models\/bitnimble\/bowerbird\/tree\/(.+)$/.exec(url)?.[1] ?? '',
    );
    if (listed != null) {
      return Response.json(
        Object.entries(listed.files).map(([name, text]) => ({
          path: name,
          oid: oidOf(name, text),
          size: text.length,
          ...(inLfs(name) ? { lfs: { oid: sha256(text) } } : {}),
        })),
      );
    }
    const file = /^\/bitnimble\/bowerbird\/resolve\/([^/]+)\/(.+)$/.exec(url);
    const at = commits.get(file?.[1] ?? '');
    if (file != null && at != null) return new Response(served(file[2] ?? '', at));
    return new Response(null, { status: 404 });
  },
});
const HUB = `http://127.0.0.1:${hub.port}`;
process.env.BOWERBIRD_MODELS_HUB = HUB;

let root = '';
let home = '';
let held: string[][] = [];
let changed: string[] = [];

function model(name: string, files: string[]): Model {
  return {
    files,
    hold: (dir) => held.push(files.map((file) => readFileSync(path.join(dir, file), 'utf8'))),
    changed: () => changed.push(name),
  };
}

const UPSCALER = model('upscaler', ['upscaler.json', 'upscaler.bin']);

function service(bundled: Installed = BUNDLED, models: Model[] = [UPSCALER]): ModelsService {
  return new ModelsService(home, models, bundled);
}

function publish(next: Commit): void {
  commits.set(next.sha, next);
  main = next;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bowerbird-models-'));
  home = path.join(root, 'models', 'downloaded');
  held = [];
  changed = [];
  commits.clear();
  served = (name, at) => at.files[name] ?? '';
  publish(BASE);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(() => {
  delete process.env.BOWERBIRD_MODELS_HUB;
  void hub.stop(true);
});

test("the build's own models are nothing to download", async () => {
  const status = await service().check();
  expect(status.current).toEqual({
    revision: BASE.sha,
    committed_at: BASE.committed_at,
    downloaded: false,
  });
  expect(status.available).toBeNull();
});

test('a newer model on the hub is offered, downloaded, used and rendered with', async () => {
  publish(NEWER);
  const models = service();

  expect((await models.check()).available).toEqual({
    revision: NEWER.sha,
    committed_at: NEWER.committed_at,
    bytes: '{"for":"newer"}'.length + 'retrained'.length,
  });

  const after = await models.download();
  expect(held).toEqual([['{"for":"newer"}', 'retrained']]);
  expect(changed).toEqual(['upscaler']);
  expect(after.current).toEqual({
    revision: NEWER.sha,
    committed_at: NEWER.committed_at,
    downloaded: true,
  });
  expect(after.available).toBeNull();
  expect(models.file(NEWER.sha, 'upscaler.bin')).toBe(path.join(home, NEWER.sha, 'upscaler.bin'));
  expect(models.file(NEWER.sha, 'installed.json')).toBeNull();
  expect(models.file(BASE.sha, 'upscaler.bin')).toBeNull();

  held = [];
  await service().load();
  expect(held).toEqual([['{"for":"newer"}', 'retrained']]);
});

test('a commit that only added a model the app does not use is nothing to download', async () => {
  publish({
    sha: 'c'.repeat(40),
    committed_at: NEWER.committed_at,
    files: { ...BASE.files, 'other.bin': 'another network' },
  });
  expect((await service().check()).available).toBeNull();
});

test('every model is held from the download, and only a changed one renders again', async () => {
  const bundled: Installed = {
    ...BUNDLED,
    git_oids: { ...BUNDLED.git_oids, 'other.bin': oidOf('other.bin', 'another network') },
  };
  publish({
    sha: 'c'.repeat(40),
    committed_at: NEWER.committed_at,
    files: { ...BASE.files, 'other.bin': 'retrained network' },
  });
  const both = (): Model[] => [UPSCALER, model('other', ['other.bin'])];
  const models = service(bundled, both());

  expect((await models.check()).available?.bytes).toBe(
    '{"for":"bundled"}'.length + 'old'.length + 'retrained network'.length,
  );
  await models.download();
  expect(held).toEqual([['{"for":"bundled"}', 'old'], ['retrained network']]);
  expect(changed).toEqual(['other']);
  expect(models.file('c'.repeat(40), 'other.bin')).toBe(
    path.join(home, 'c'.repeat(40), 'other.bin'),
  );

  held = [];
  await service(bundled, both()).load();
  expect(held).toEqual([['{"for":"bundled"}', 'old'], ['retrained network']]);

  held = [];
  rmSync(path.join(home, 'c'.repeat(40), 'other.bin'));
  const incomplete = service(bundled, both());
  await incomplete.load();
  expect(held).toEqual([]);
  expect(existsSync(home)).toBe(false);
  expect(incomplete.status().current.downloaded).toBe(false);
});

test('a file that does not match what the hub lists is refused, and nothing changes', async () => {
  publish(NEWER);
  served = (name, at) => (inLfs(name) ? 'tampered' : (at.files[name] ?? ''));
  const models = service();
  await models.check();

  await expect(models.download()).rejects.toThrow(/does not match/);
  expect(held).toEqual([]);
  expect(changed).toEqual([]);
  expect(existsSync(path.join(home, 'installed.json'))).toBe(false);
  expect(existsSync(path.join(home, NEWER.sha))).toBe(false);
  expect(models.status().current.downloaded).toBe(false);
});

test('a build that carries a model as new as the downloaded one drops the download', async () => {
  publish(NEWER);
  const models = service();
  await models.check();
  await models.download();
  held = [];

  const updated = service({ ...BUNDLED, revision: NEWER.sha, committed_at: NEWER.committed_at });
  await updated.load();
  expect(held).toEqual([]);
  expect(existsSync(home)).toBe(false);
  expect(updated.status().current.downloaded).toBe(false);
});

test('a revision that is not a commit id is refused, since it names a directory', async () => {
  publish({ ...NEWER, sha: '..' });
  const status = await service().check();
  expect(status.error).not.toBeNull();
  expect(status.available).toBeNull();
});

test('a download a kill left part-written is dropped at the next start', async () => {
  mkdirSync(path.join(home, `${NEWER.sha}.partial`), { recursive: true });
  await service().load();
  expect(existsSync(home)).toBe(false);
});

test('a model the renderer refuses is not recorded as in use', async () => {
  publish(NEWER);
  const models = service(BUNDLED, [
    {
      ...UPSCALER,
      hold: () => {
        throw new Error('could not read the upscaler model');
      },
    },
  ]);
  await models.check();
  await expect(models.download()).rejects.toThrow(/could not read/);
  expect(changed).toEqual([]);
  expect(models.status().current.downloaded).toBe(false);
  expect(existsSync(path.join(home, 'installed.json'))).toBe(false);
});

test('a hub that cannot be reached is recorded, not thrown', async () => {
  process.env.BOWERBIRD_MODELS_HUB = 'http://127.0.0.1:9';
  try {
    const status = await service().check(true);
    expect(status.error).not.toBeNull();
    expect(status.available).toBeNull();
  } finally {
    process.env.BOWERBIRD_MODELS_HUB = HUB;
  }
});
