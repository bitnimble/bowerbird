// Ticking a stage sends what is left *out*, so the row is empty for a library that has traded
// nothing away and a stage added in a later version arrives switched on. Sent the other way round -
// a list of what runs - an upgrade would silently turn the new stage off for every library.
import { expect, test } from 'bun:test';
import { type Library, type UpdateLibraryRequest } from '../../../../../src/schemas/libraries';
import {
  type OptionalStage,
  type RenderedRendition,
} from '../../../../../src/schemas/render_stages';
import { librariesApi } from '../../../api/libraries';
import { restoreApiAfterTests } from '../../../test_api';
import { LibrariesPresenter } from '../libraries_presenter';
import { LibrariesStore } from '../libraries_store';

restoreApiAfterTests();

const LIBRARY = {
  id: 'lib',
  render_skip_full: ['lens', 'colour'],
  render_skip_max: [],
  denoiser: 'galosh',
} as unknown as Library;

const PHONE = {
  id: 'phone',
  render_skip_full: ['dust'],
  render_skip_max: ['dust'],
  denoiser: 'pmrid',
} as unknown as Library;

function presenterOver(
  libraries: Library[],
  update: typeof librariesApi.update,
): { presenter: LibrariesPresenter; store: LibrariesStore } {
  const store = new LibrariesStore();
  store.libraries = libraries;
  librariesApi.update = update;
  librariesApi.list = () => Promise.resolve(libraries);
  librariesApi.getDefaults = () => Promise.resolve({} as never);
  return { presenter: new LibrariesPresenter(store, { showError: () => {} } as never), store };
}

async function sentToEach(
  libraries: Library[],
  rendition: RenderedRendition,
  stage: OptionalStage,
  runs: boolean,
): Promise<Record<string, UpdateLibraryRequest>> {
  const asked: Record<string, UpdateLibraryRequest> = {};
  const { presenter } = presenterOver(libraries, (id, body) => {
    asked[id] = body;
    return Promise.resolve(LIBRARY);
  });
  await presenter.setRenderStage(rendition, stage, runs);
  return asked;
}

async function sent(
  library: Library,
  rendition: RenderedRendition,
  stage: OptionalStage,
  runs: boolean,
): Promise<UpdateLibraryRequest | undefined> {
  return (await sentToEach([library], rendition, stage, runs))[library.id];
}

test('unticking a stage adds it to that rendition alone', async () => {
  expect(await sent(LIBRARY, 'max', 'denoise', false)).toEqual({ render_skip_max: ['denoise'] });
  expect(await sent(LIBRARY, 'full', 'denoise', false)).toEqual({
    render_skip_full: ['denoise', 'lens', 'colour'],
  });
});

test('ticking the lens leaves colour off until explicitly enabled', async () => {
  expect(await sent(LIBRARY, 'full', 'lens', true)).toEqual({ render_skip_full: ['colour'] });
  expect(await sent({ ...LIBRARY, render_skip_full: ['colour'] }, 'full', 'colour', true)).toEqual({
    render_skip_full: [],
  });
});

test('unticking a stage that is already out sends the same list rather than two of it', async () => {
  expect(await sent(LIBRARY, 'full', 'lens', false)).toEqual({
    render_skip_full: ['lens', 'colour'],
  });
});

test('disabling lens also disables colour and colour cannot enable it', async () => {
  expect(await sent(LIBRARY, 'max', 'lens', false)).toEqual({
    render_skip_max: ['lens', 'colour'],
  });
  expect(await sent(LIBRARY, 'full', 'colour', true)).toEqual({
    render_skip_full: ['lens', 'colour'],
  });
});

test('a stage change reaches every library and leaves the stages each already differs on', async () => {
  expect(await sentToEach([LIBRARY, PHONE], 'full', 'sharpen', false)).toEqual({
    lib: { render_skip_full: ['lens', 'colour', 'sharpen'] },
    phone: { render_skip_full: ['dust', 'sharpen'] },
  });
});

test('a second tick before the first has saved keeps both', async () => {
  let held = LIBRARY;
  const { presenter } = presenterOver([LIBRARY], (_id, body) => {
    held = { ...held, ...body } as Library;
    return Promise.resolve(held);
  });
  librariesApi.list = () => Promise.resolve([held]);

  await Promise.all([
    presenter.setRenderStage('max', 'denoise', false),
    presenter.setRenderStage('max', 'sharpen', false),
  ]);

  expect(held.render_skip_max).toEqual(['denoise', 'sharpen']);
});

test('a denoiser change reaches every library', async () => {
  const asked: Record<string, UpdateLibraryRequest> = {};
  const { presenter } = presenterOver([LIBRARY, PHONE], (id, body) => {
    asked[id] = body;
    return Promise.resolve(LIBRARY);
  });

  await presenter.setDenoiser('upscaler');

  expect(asked).toEqual({ lib: { denoiser: 'upscaler' }, phone: { denoiser: 'upscaler' } });
});

test('one library refusing still writes the rest and says what went wrong', async () => {
  const asked: string[] = [];
  const { presenter, store } = presenterOver([LIBRARY, PHONE], (id) => {
    asked.push(id);
    return id === 'lib' ? Promise.reject(new Error('Library is busy.')) : Promise.resolve(PHONE);
  });

  await presenter.setDenoiser('pmrid');

  expect(asked).toEqual(['lib', 'phone']);
  expect(store.error).toBe('Library is busy.');
});
