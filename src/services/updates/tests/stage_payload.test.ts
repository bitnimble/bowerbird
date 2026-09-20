// Staging a payload, against a real server and a real tarball. This is the only part of an
// update that writes to disk, and the order it writes in is the whole of what makes a kill
// at any point survivable - so the order is what is asserted, not just the happy path.
//
// The supervisor is Rust and reads these same names (`native/launcher/src/lib.rs`), which
// nothing but prose holds it to. A rename here that is not made there is an update that
// downloads, verifies and unpacks, and then never installs - so the names are spelled out
// below rather than derived, and this is the file that fails when one of them moves.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stagePayload } from '../update_service';

let home = '';
let source = '';
let server: ReturnType<typeof Bun.serve> | null = null;

/** A real gzipped tar with one recognisable file in it. */
async function tarball(contents: string): Promise<Uint8Array> {
  const from = path.join(source, 'payload');
  await Bun.write(path.join(from, 'bowerbird-app'), contents);
  await Bun.write(path.join(from, 'resources', 'server', 'index.js'), '// the server');
  const out = path.join(source, 'payload.tar.gz');
  const packed = Bun.spawn(['tar', '-czf', out, '-C', from, '.'], { stderr: 'pipe' });
  if ((await packed.exited) !== 0) throw new Error(await new Response(packed.stderr).text());
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

function serve(handler: (request: Request) => Response | Promise<Response>): string {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  return `http://127.0.0.1:${server.port}`;
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'bowerbird-stage-home-'));
  source = mkdtempSync(path.join(tmpdir(), 'bowerbird-stage-src-'));
});

afterEach(() => {
  server?.stop(true);
  server = null;
  rmSync(home, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test('a payload lands unpacked, with the marker written last', async () => {
  const bytes = await tarball('the new app');
  const origin = serve(() => new Response(bytes));

  await stagePayload(home, {
    url: `${origin}/bowerbird-payload-linux-x86_64.tar.gz`,
    filename: 'bowerbird-payload-linux-x86_64.tar.gz',
    sha256: sha256(bytes),
    version: '0.2.0',
  });

  // The contents at the root of `staged/`, which is what the supervisor renames into
  // `versions/<v>` and then runs out of.
  expect(readFileSync(path.join(home, 'staged', 'bowerbird-app'), 'utf8')).toBe('the new app');
  expect(existsSync(path.join(home, 'staged', 'resources', 'server', 'index.js'))).toBe(true);
  expect(readFileSync(path.join(home, 'staged.version'), 'utf8').trim()).toBe('0.2.0');
  // The scratch directory goes; the tarball does not sit there costing its own size again.
  expect(existsSync(path.join(home, 'download'))).toBe(false);
});

// The marker is what says `staged/` is complete, so anything that fails must fail before
// it is written - otherwise the supervisor installs a half-unpacked directory.
test('a payload whose checksum is wrong stages nothing', async () => {
  const bytes = await tarball('not what was published');
  const origin = serve(() => new Response(bytes));

  await expect(
    stagePayload(home, {
      url: `${origin}/payload.tar.gz`,
      filename: 'payload.tar.gz',
      sha256: 'b'.repeat(64),
      version: '0.2.0',
    }),
  ).rejects.toThrow(/checksum/);

  expect(existsSync(path.join(home, 'staged.version'))).toBe(false);
  expect(existsSync(path.join(home, 'staged'))).toBe(false);
});

test('a download the release does not have stages nothing', async () => {
  const origin = serve(() => new Response('no such file', { status: 404 }));

  await expect(
    stagePayload(home, { url: `${origin}/gone.tar.gz`, filename: 'gone.tar.gz', sha256: 'c'.repeat(64), version: '0.2.0' }),
  ).rejects.toThrow(/404/);
  expect(existsSync(path.join(home, 'staged.version'))).toBe(false);
});

// The filename is read out of a manifest fetched over the network, and it is joined onto a
// path. Only its basename may reach the filesystem.
test('a payload named to escape the scratch directory cannot', async () => {
  const bytes = await tarball('the new app');
  const origin = serve(() => new Response(bytes));

  await stagePayload(home, {
    url: `${origin}/evil`,
    filename: '../../../escaped.tar.gz',
    sha256: sha256(bytes),
    version: '0.2.0',
  });

  expect(existsSync(path.join(home, '..', '..', '..', 'escaped.tar.gz'))).toBe(false);
  expect(existsSync(path.join(home, 'staged', 'bowerbird-app'))).toBe(true);
});

// Staging twice in a row has to be the second payload, not the two of them merged: a file
// the new version dropped would otherwise survive from the old one.
test('a second staging replaces the first rather than merging into it', async () => {
  const first = await tarball('the first app');
  let bytes = first;
  const origin = serve(() => new Response(bytes));
  const stage = async (sum: string, version: string): Promise<void> =>
    stagePayload(home, { url: `${origin}/p.tar.gz`, filename: 'p.tar.gz', sha256: sum, version });

  await stage(sha256(first), '0.2.0');
  await Bun.write(path.join(home, 'staged', 'left-behind'), 'from the first');

  rmSync(path.join(source, 'payload'), { recursive: true, force: true });
  bytes = await tarball('the second app');
  await stage(sha256(bytes), '0.3.0');

  expect(readFileSync(path.join(home, 'staged', 'bowerbird-app'), 'utf8')).toBe('the second app');
  expect(readdirSync(path.join(home, 'staged'))).not.toContain('left-behind');
  expect(readFileSync(path.join(home, 'staged.version'), 'utf8').trim()).toBe('0.3.0');
});
