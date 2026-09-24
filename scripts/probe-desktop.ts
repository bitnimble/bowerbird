// Whether the desktop app really carries its own library.
//
// Starts the built shell with no server anywhere in sight - no `BOWERBIRD_SERVER`,
// nothing listening on the usual port - and waits for it to say it is serving one
// itself. That is the whole of milestone 4's claim: open the app on a machine with
// no Bowerbird on it and you have a library.
//
// Under `xvfb-run` because the shell is a real windowed app and the display has to
// exist before it starts.
import { spawn } from 'bun';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const RESOURCES = join(ROOT, 'src-tauri', 'resources');
const HOME = join(tmpdir(), `bowerbird-desktop-probe-${process.pid}`);

function sidecar(): string {
  const dir = join(ROOT, 'src-tauri', 'binaries');
  const found = existsSync(dir)
    ? [...new Bun.Glob('bowerbird-server-*').scanSync({ cwd: dir })].map((name) => join(dir, name))
    : [];
  if (found.length === 0) throw new Error('no sidecar built. Run `bun run build:sidecar` first.');
  return found[0]!;
}

function shell(): string {
  for (const profile of ['debug', 'release']) {
    const candidate = join(ROOT, 'src-tauri', 'target', profile, 'app');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('no desktop shell built. Run `bun run scripts/cargo.ts build --manifest-path src-tauri/Cargo.toml`.');
}

rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

// `--no-sandbox` because the Linux shell is CEF, and CEF's SUID sandbox helper has
// to be owned by root with mode 4755 - which a binary built into `target/` is not,
// and which is not something a build should be arranging. It says nothing about
// how the app ships; it is how this check runs it.
const env = { ...process.env };
// Deleted rather than set to undefined, which Bun passes as the *string*
// "undefined" - and the app reads any value at all as "a server was named for
// me", so it starts none of its own and the probe waits for a line that never
// comes. The point of this check is an app told about no server whatsoever.
delete env.BOWERBIRD_SERVER;

const app = spawn(['xvfb-run', '-a', shell(), '--no-sandbox'], {
  cwd: ROOT,
  env: {
    ...env,
    // Its own home, so the probe uses a scratch catalogue rather than the reader's.
    HOME,
    XDG_DATA_HOME: join(HOME, 'data'),
    XDG_CONFIG_HOME: join(HOME, 'config'),
    BOWERBIRD_SIDECAR: sidecar(),
    BOWERBIRD_RESOURCES: RESOURCES,
  },
  stdout: 'pipe',
  stderr: 'pipe',
});

const serving = /serving this library locally on (http:\/\/\S+)/;
let origin: string | null = null;

async function watch(stream: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk);
    process.stdout.write(text);
    const found = text.match(serving);
    if (found != null) origin = found[1]!;
  }
}

void watch(app.stdout as ReadableStream<Uint8Array>);
void watch(app.stderr as ReadableStream<Uint8Array>);

try {
  for (let attempt = 0; attempt < 240 && origin == null; attempt++) await Bun.sleep(250);
  if (origin == null) throw new Error('the app never reported a local library');

  // Only the shell holds the server's token, so what a stranger can check is that it is refused.
  const listed = await fetch(`${origin}/api/libraries`);
  const body = (await listed.json().catch(() => null)) as { error?: { code?: string } } | null;
  if (listed.status !== 401 || body?.error?.code !== 'UNAUTHORIZED') {
    throw new Error(`the local server answered ${listed.status} to a request without its token`);
  }
  console.log(`the desktop app is serving its own library on ${origin}, to itself only`);
} finally {
  // The shell forks a browser's worth of children, and killing the one this
  // spawned leaves the rest holding the process group open - which reads as a
  // check that never finishes rather than one that passed.
  app.kill();
  await Bun.sleep(500);
  try {
    process.kill(-app.pid, 'SIGKILL');
  } catch {
    // Already gone, which is the ordinary case.
  }
  rmSync(HOME, { recursive: true, force: true });
  process.exit(0);
}
