// What the form hands to Sentry, and the half that matters: a photograph nobody ticked is
// never fetched, and a report that cannot be sent says which of the two reasons it was.
import { afterAll, expect, test } from 'bun:test';
import type { PhotoDetail } from '../../../../../src/schemas/photos';
import { exportsApi } from '../../../api/exports';
import { photosApi } from '../../../api/photos';
import { restoreApiAfterTests } from '../../../test_api';
import { FeedbackPresenter } from '../feedback_presenter';
import { FeedbackStore } from '../feedback_store';
import { REQUEST_CEILING } from '../photo_attachments';
import { bugReporter, type BugReport } from '../report_bug';

restoreApiAfterTests();

// `bugReporter` is a module singleton like the domain APIs, and `restoreApiAfterTests` does not
// know about it: a stub left on it outlives this file and answers another suite's send.
const sendsForReal = bugReporter.send;
afterAll(() => {
  bugReporter.send = sendsForReal;
});

const MB = 1024 * 1024;
const WRITTEN = { message: 'the photo turned black', email: '', version: '1.2.3' };

function photo(over: Partial<PhotoDetail> = {}): PhotoDetail {
  return { id: 'ph-1', has_embedded: true, file_size: 20 * MB, ...over } as unknown as PhotoDetail;
}

function build(bytes = 1): {
  store: FeedbackStore;
  presenter: FeedbackPresenter;
  asked: string[];
  reports: BugReport[];
  shown: string[];
} {
  const asked: string[] = [];
  const reports: BugReport[] = [];
  const shown: string[] = [];
  photosApi.attachment = (photoId, form) => {
    asked.push(`${photoId}/${form}`);
    return Promise.resolve({ bytes: new Uint8Array(bytes), mediaType: 'image/jpeg', filename: null });
  };
  exportsApi.create = () =>
    Promise.resolve({ bytes: new Uint8Array(bytes), mediaType: 'image/jpeg', filename: null });
  bugReporter.send = (report: BugReport): Promise<void> => {
    reports.push(report);
    return Promise.resolve();
  };

  const store = new FeedbackStore();
  const toasts = { show: (message: string): void => void shown.push(message) };
  return { store, presenter: new FeedbackPresenter(store, toasts as never), asked, reports, shown };
}

test('a report nobody attached a photograph to asks the server for nothing', async () => {
  const { store, presenter, asked, reports, shown } = build();
  store.photo = photo();

  const sent = await presenter.send({ ...WRITTEN, includePhoto: false, raw: true, strip: true });

  expect(sent).toBe('sent');
  expect(asked).toEqual([]);
  expect(reports[0]?.attachments).toEqual([]);
  expect(shown).toEqual(["We've got your report."]);
  expect(store.open).toBe(false);
});

test('ticking the photograph carries its files, and closes the form once they land', async () => {
  const { store, presenter, asked, reports } = build();
  store.photo = photo();
  store.open = true;

  const sent = await presenter.send({ ...WRITTEN, includePhoto: true, raw: false, strip: true });

  expect(sent).toBe('sent');
  expect(asked).toEqual(['ph-1/embedded', 'ph-1/full', 'ph-1/analysis']);
  expect(reports[0]?.attachments).toHaveLength(4);
  expect(store.open).toBe(false);
});

test('an original too large for a report is left out rather than fetched', async () => {
  const { store, presenter, asked } = build();
  store.photo = photo({ file_size: REQUEST_CEILING + 1 });

  const sent = await presenter.send({ ...WRITTEN, includePhoto: true, raw: true, strip: true });

  // `rawFits` refuses it before `attachmentsFor` is ever asked for the bytes.
  expect(sent).toBe('sent');
  expect(asked).not.toContain('ph-1/original');
});

test('pictures that together outweigh the ceiling are refused, and say so', async () => {
  const { store, presenter, reports } = build(15 * MB);
  store.photo = photo();

  const sent = await presenter.send({ ...WRITTEN, includePhoto: true, raw: false, strip: true });

  expect(sent).toBe('too-large');
  expect(reports).toEqual([]);
});

test('a send that throws is a failure the form can name', async () => {
  const { store, presenter } = build();
  store.photo = photo();
  bugReporter.send = () => Promise.reject(new Error('the network went'));

  expect(await presenter.send({ ...WRITTEN, includePhoto: false, raw: false, strip: true })).toBe('failed');
});
