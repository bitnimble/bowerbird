// Ticking a stage sends what is left *out*, so the row is empty for a library that has traded
// nothing away and a stage added in a later version arrives switched on. Sent the other way round -
// a list of what runs - an upgrade would silently turn the new stage off for every library.
import { expect, test } from 'bun:test';
import { type Library, type UpdateLibraryRequest } from '../../../../../src/schemas/libraries';
import { type OptionalStage, type RenderedRendition } from '../../../../../src/schemas/render_stages';
import { librariesApi } from '../../../api/libraries';
import { restoreApiAfterTests } from '../../../test_api';
import { LibrariesPresenter } from '../libraries_presenter';
import { LibrariesStore } from '../libraries_store';

restoreApiAfterTests();

const LIBRARY = {
  id: 'lib',
  render_skip_full: ['lens', 'colour'],
  render_skip_max: [],
} as unknown as Library;

async function sent(
  library: Library,
  rendition: RenderedRendition,
  stage: OptionalStage,
  runs: boolean,
): Promise<UpdateLibraryRequest> {
  const store = new LibrariesStore();
  store.libraries = [library];
  let asked: UpdateLibraryRequest = {};
  librariesApi.update = (_id, body) => {
    asked = body;
    return Promise.resolve(library);
  };
  librariesApi.list = () => Promise.resolve([library]);
  librariesApi.getDefaults = () => Promise.resolve({} as never);
  await new LibrariesPresenter(store, { showError: () => {} } as never).setRenderStage(
    library.id,
    rendition,
    stage,
    runs,
  );
  return asked;
}

test('unticking a stage adds it to that rendition alone', async () => {
  expect(await sent(LIBRARY, 'max', 'denoise', false)).toEqual({ render_skip_max: ['denoise'] });
  expect(await sent(LIBRARY, 'full', 'denoise', false)).toEqual({ render_skip_full: ['denoise', 'lens', 'colour'] });
});

test('ticking the lens leaves colour off until explicitly enabled', async () => {
  expect(await sent(LIBRARY, 'full', 'lens', true)).toEqual({ render_skip_full: ['colour'] });
  expect(await sent({ ...LIBRARY, render_skip_full: ['colour'] }, 'full', 'colour', true)).toEqual({ render_skip_full: [] });
});

test('unticking a stage that is already out sends the same list rather than two of it', async () => {
  expect(await sent(LIBRARY, 'full', 'lens', false)).toEqual({ render_skip_full: ['lens', 'colour'] });
});

test('disabling lens also disables colour and colour cannot enable it', async () => {
  expect(await sent(LIBRARY, 'max', 'lens', false)).toEqual({ render_skip_max: ['lens', 'colour'] });
  expect(await sent(LIBRARY, 'full', 'colour', true)).toEqual({ render_skip_full: ['lens', 'colour'] });
});
