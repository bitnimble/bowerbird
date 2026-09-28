// The promise an air-gapped deployment is making decisions on: emptied, the update
// setting means this server reaches the network zero times, not "fails quietly once an
// hour". Nothing else here asserts that, and it is not visible from any one function -
// `check` returns early, and `apply` has to run out of road on its own.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeReleaseManifest } from '../release_manifest';
import { UpdateService } from '../update_service';

const REAL_FETCH = globalThis.fetch;
const REAL_ENV = { ...process.env };
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((input: string | URL | Request) => {
    calls.push(String(input));
    return Promise.reject(new Error('this test must not reach the network'));
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  process.env = { ...REAL_ENV };
});

function disabled(by: 'BOWERBIRD_UPDATE_URL' | 'BOWERBIRD_UPDATE_REPO'): UpdateService {
  process.env = { ...REAL_ENV, [by]: '' };
  // Constructed after the environment is set: the endpoint is resolved once, at construction.
  return new UpdateService();
}

for (const by of ['BOWERBIRD_UPDATE_URL', 'BOWERBIRD_UPDATE_REPO'] as const) {
  test(`${by} empty: a check asks nobody`, async () => {
    const status = await disabled(by).check();
    expect(calls).toEqual([]);
    expect(status.newer).toEqual([]);
    expect(status.checked_at).toBeNull();
  });

  test(`${by} empty: a forced check asks nobody either`, async () => {
    await disabled(by).check(true);
    expect(calls).toEqual([]);
  });

  // The half that is not obvious: `apply` never consults the endpoint setting, it runs out
  // of releases to install. Were that ever to change, this is what would notice.
  test(`${by} empty: applying refuses without reaching for anything`, async () => {
    const service = disabled(by);
    // After the service is built, because `disabled` replaces the environment: the install
    // has to be one that can replace itself for `apply` to get as far as looking for a release.
    process.env.BOWERBIRD_UPDATES = '/tmp/bowerbird-update-service-test';
    await expect(service.apply()).rejects.toThrow(/nothing newer/);
    expect(calls).toEqual([]);
  });
}

test('left alone, a check does reach for the endpoint it was given', async () => {
  process.env = { ...REAL_ENV, BOWERBIRD_UPDATE_URL: 'https://releases.example.invalid/list.json' };
  await new UpdateService().check();
  expect(calls).toEqual(['https://releases.example.invalid/list.json']);
});

describe('a newer release', () => {
  const LIST = 'https://releases.example.invalid/list.json';
  const MANIFEST = 'https://releases.example.invalid/release.yml';

  function published(env: Record<string, string>): UpdateService {
    process.env = { ...REAL_ENV, BOWERBIRD_UPDATE_URL: LIST };
    delete process.env.BOWERBIRD_UPDATES;
    Object.assign(process.env, env);
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === LIST) {
        return Response.json([
          { tag_name: 'v99.0.0', published_at: null, html_url: 'https://releases.example.invalid/v99', assets: [{ name: 'release.yml', browser_download_url: MANIFEST }] },
        ]);
      }
      if (url === MANIFEST) {
        return new Response(
          writeReleaseManifest({
            version: '99.0.0',
            tag: 'v99.0.0',
            assets: {
              'docker-x86_64': { image: 'ghcr.io/example/app:99.0.0' },
              'macos-arm64': { installer: 'Bowerbird.dmg', payload: 'payload.tar.gz', payload_sha256: 'a'.repeat(64) },
            },
          }),
        );
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    return new UpdateService();
  }

  test('points the container at its image, and offers it nothing to install', async () => {
    const service = published({ BOWERBIRD_PLATFORM: 'docker-x86_64' });
    const status = await service.check();
    expect(status.newer.map((release) => release.version)).toEqual(['99.0.0']);
    expect(status.install_hint).toBe('ghcr.io/example/app:99.0.0');
    expect(status.can_install).toBe(false);
    await expect(service.apply()).rejects.toThrow(/cannot replace itself/);
  });

  test('is installable where the desktop app says where to stage it', async () => {
    const status = await published({ BOWERBIRD_PLATFORM: 'macos-arm64', BOWERBIRD_UPDATES: '/tmp/bowerbird-update-service-test' }).check();
    expect(status.can_install).toBe(true);
  });
});
