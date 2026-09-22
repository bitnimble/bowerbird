// What a report carries, and that the SDK behind it is started with nothing switched on:
// the form is the only thing in the app that reaches Sentry, and a default integration is
// how that would become error tracking without anyone deciding to.
import { afterAll, expect, mock, test } from 'bun:test';
import { registerDom } from '../../../test_dom';

// The whole suite shares one process, and every other file's idea of this app is a build
// with no DSN - which is the App the sidebar's tests render.
process.env.VITE_SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
afterAll(() => {
  delete process.env.VITE_SENTRY_DSN;
});

const started: Record<string, unknown>[] = [];
const contexts: [string, unknown][] = [];
const sent: Record<string, unknown>[] = [];
const carried: { attachments?: { filename: string }[] }[] = [];

void mock.module('@sentry/browser', () => ({
  init: (options: Record<string, unknown>): void => void started.push(options),
  setContext: (name: string, value: unknown): void => void contexts.push([name, value]),
  sendFeedback: (
    params: Record<string, unknown>,
    hint: { attachments?: { filename: string }[] },
  ): Promise<string> => {
    sent.push(params);
    carried.push(hint);
    return Promise.resolve('an-id');
  },
}));

registerDom();
const { bugReporter } = await import('../report_bug');

test('a build with a DSN offers the form', () => {
  expect(bugReporter.canSend()).toBe(true);
});

test('a report carries what was written, the version, and this machine', async () => {
  await bugReporter.send({
    message: 'the photo turned black',
    email: 'her@example.com',
    version: '1.2.3',
    attachments: [],
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    message: 'the photo turned black',
    email: 'her@example.com',
    tags: { version: '1.2.3' },
  });

  const [name, diagnostics] = contexts[0]!;
  expect(name).toBe('bowerbird');
  expect(diagnostics).toMatchObject({ adapter: 'no WebGPU' });
  expect((diagnostics as { browser: string }).browser).toContain('jsdom');

  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({ defaultIntegrations: false, integrations: [], sendClientReports: false });
});

test('an empty email is left off rather than sent blank', async () => {
  await bugReporter.send({ message: 'a second report', email: '', version: undefined, attachments: [] });

  expect(sent[1]).toMatchObject({ message: 'a second report', tags: { version: 'unknown' } });
  expect(sent[1]!.email).toBeUndefined();
});

test('the photograph rides in the envelope beside what was written', async () => {
  const raw = { filename: 'DSC00853.ARW', data: new Uint8Array([1, 2, 3]), contentType: 'image/x-sony-arw' };

  await bugReporter.send({ message: 'this frame', email: '', version: '1.2.3', attachments: [raw] });

  expect(carried.at(-1)?.attachments?.map((part) => part.filename)).toEqual(['DSC00853.ARW']);
});

test('a report larger than Sentry will take is refused rather than posted', async () => {
  const huge = { filename: 'big.ARW', data: new Uint8Array(41 * 1024 * 1024), contentType: 'image/x-sony-arw' };
  const before = sent.length;

  await expect(
    bugReporter.send({ message: 'too much', email: '', version: '1.2.3', attachments: [huge] }),
  ).rejects.toThrow('larger than Sentry');
  expect(sent).toHaveLength(before);
});

// Last in the file: it leaves the DSN unset, which is what `afterAll` would have done anyway.
test('a build with no DSN offers nothing, and refuses to send', async () => {
  delete process.env.VITE_SENTRY_DSN;

  const before = sent.length;

  expect(bugReporter.canSend()).toBe(false);
  await expect(
    bugReporter.send({ message: 'nowhere to go', email: '', version: '1.2.3', attachments: [] }),
  ).rejects.toThrow('no Sentry DSN');
  expect(sent).toHaveLength(before);
});
