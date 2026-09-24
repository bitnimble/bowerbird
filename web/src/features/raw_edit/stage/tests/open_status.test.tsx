import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { registerDom } from '../../../../test_dom';
import { EditStore } from '../../edit/edit_store';
import { OpenStageSchema } from '../../local_decode/local_open';
import { StageStore } from '../stage_store';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { OpenStatus } = await import('../raw_edit_stage');

afterEach(cleanup);

function opening(): StageStore {
  const stage = new StageStore(new EditStore());
  stage.status = 'opening';
  render(<OpenStatus stage={stage} />);
  return stage;
}

test('names each step of the open as it is reached', () => {
  const stage = opening();
  expect(screen.getByRole('status').textContent).toBe('Preparing…');

  act(() => runInAction(() => (stage.step = 'decoding')));
  expect(screen.getByRole('status').textContent).toBe('Decoding…');

  act(() => runInAction(() => (stage.step = 'matching')));
  expect(screen.getByRole('status').textContent).toBe('Matching colour and lens distortion…');

  act(() => runInAction(() => (stage.status = 'live')));
  expect(screen.queryByRole('status')).toBeNull();
});

test('says why the picture failed, in place of the spinner', () => {
  const stage = opening();
  act(() =>
    runInAction(() => {
      stage.status = 'failed';
      stage.message = 'the decoder could not read this file';
    }),
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe(
    "We couldn't show this photo. Open it again to retry.the decoder could not read this file",
  );
});

test("the module's stages are the ones it reports", async () => {
  const table = await Bun.file(
    new URL('../../../../../../test/fixtures/tables/open-stages.txt', import.meta.url).pathname,
  ).text();
  expect(table.trim().split('\n')).toEqual(OpenStageSchema.options);
});
