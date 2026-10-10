import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelsService, type Installed } from '../models_service';

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
let changed = 0;

function service(bundled: Installed = BUNDLED): ModelsService {
  return new ModelsService(
    home,
    (manifest, weights) =>
      held.push([readFileSync(manifest, 'utf8'), readFileSync(weights, 'utf8')]),
    () => (changed += 1),
    bundled,
  );
}

function publish(next: Commit): void {
  commits.set(next.sha, next);
  main = next;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'bowerbird-models-'));
  home = path.join(root, 'models', 'upscaler');
  held = [];
  changed = 0;
  commits.clear();
  served = (name, at) => at.files[name] ?? '';
  publish(BASE);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));
afterAll(() => {
  delete process.env.BOWERBIRD_MODELS_HUB;
  void hub.stop(true);
});

test("the build's own model is nothing to download", async () => {
  const status = await service().check();
  expect(status.upscaler.current).toEqual({
    revision: BASE.sha,
    committed_at: BASE.committed_at,
    downloaded: false,
  });
  expect(status.upscaler.available).toBeNull();
});

test('a newer model on the hub is offered, downloaded, used and rendered with', async () => {
  publish(NEWER);
  const models = service();

  expect((await models.check()).upscaler.available).toEqual({
    revision: NEWER.sha,
    committed_at: NEWER.committed_at,
    bytes: '{"for":"newer"}'.length + 'retrained'.length,
  });

  const after = await models.download();
  expect(held).toEqual([['{"for":"newer"}', 'retrained']]);
  expect(changed).toBe(1);
  expect(after.upscaler.current).toEqual({
    revision: NEWER.sha,
    committed_at: NEWER.committed_at,
    downloaded: true,
  });
  expect(after.upscaler.available).toBeNull();
  expect(models.file('upscaler.bin')).toBe(path.join(home, NEWER.sha, 'upscaler.bin'));
  expect(models.file('installed.json')).toBeNull();

  held = [];
  await service().load();
  expect(held).toEqual([['{"for":"newer"}', 'retrained']]);
});

test('a commit that only added another model is nothing to download', async () => {
  publish({
    sha: 'c'.repeat(40),
    committed_at: NEWER.committed_at,
    files: { ...BASE.files, 'other.bin': 'another network' },
  });
  expect((await service().check()).upscaler.available).toBeNull();
});

test('a file that does not match what the hub lists is refused, and nothing changes', async () => {
  publish(NEWER);
  served = (name, at) => (inLfs(name) ? 'tampered' : (at.files[name] ?? ''));
  const models = service();
  await models.check();

  await expect(models.download()).rejects.toThrow(/does not match/);
  expect(held).toEqual([]);
  expect(changed).toBe(0);
  expect(existsSync(path.join(home, 'installed.json'))).toBe(false);
  expect(existsSync(path.join(home, NEWER.sha))).toBe(false);
  expect(models.status().upscaler.current.downloaded).toBe(false);
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
  expect(updated.status().upscaler.current.downloaded).toBe(false);
});

test('a revision that is not a commit id is refused, since it names a directory', async () => {
  publish({ ...NEWER, sha: '..' });
  const status = await service().check();
  expect(status.error).not.toBeNull();
  expect(status.upscaler.available).toBeNull();
});

test('a download a kill left part-written is dropped at the next start', async () => {
  mkdirSync(path.join(home, `${NEWER.sha}.partial`), { recursive: true });
  await service().load();
  expect(existsSync(home)).toBe(false);
});

test('a model the renderer refuses is not recorded as in use', async () => {
  publish(NEWER);
  const models = new ModelsService(
    home,
    () => {
      throw new Error('could not read the upscaler model');
    },
    () => (changed += 1),
    BUNDLED,
  );
  await models.check();
  await expect(models.download()).rejects.toThrow(/could not read/);
  expect(changed).toBe(0);
  expect(models.status().upscaler.current.downloaded).toBe(false);
  expect(existsSync(path.join(home, 'installed.json'))).toBe(false);
});

test('a hub that cannot be reached is recorded, not thrown', async () => {
  process.env.BOWERBIRD_MODELS_HUB = 'http://127.0.0.1:9';
  try {
    const status = await service().check(true);
    expect(status.error).not.toBeNull();
    expect(status.upscaler.available).toBeNull();
  } finally {
    process.env.BOWERBIRD_MODELS_HUB = HUB;
  }
});
