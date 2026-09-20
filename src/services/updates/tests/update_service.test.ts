// The promise an air-gapped deployment is making decisions on: emptied, the update
// setting means this server reaches the network zero times, not "fails quietly once an
// hour". Nothing else here asserts that, and it is not visible from any one function -
// `check` returns early, and `apply` has to run out of road on its own.
import { afterEach, beforeEach, expect, test } from 'bun:test';
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
    // After the service is built, because `disabled` replaces the environment: a supervisor
    // has to be in front of this for `apply` to get as far as looking for a release at all.
    process.env.BOWERBIRD_SUPERVISED = '1';
    process.env.BOWERBIRD_HOME = '/tmp/bowerbird-update-service-test';
    await expect(service.apply()).rejects.toThrow(/nothing newer/);
    expect(calls).toEqual([]);
  });
}

test('left alone, a check does reach for the endpoint it was given', async () => {
  process.env = { ...REAL_ENV, BOWERBIRD_UPDATE_URL: 'https://releases.example.invalid/list.json' };
  await new UpdateService().check();
  expect(calls).toEqual(['https://releases.example.invalid/list.json']);
});
