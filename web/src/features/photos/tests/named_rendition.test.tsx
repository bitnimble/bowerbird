// The label naming the rendition the reader picked, which is on screen for a beat and then
// gone. What it costs to get this wrong is a pill that never leaves: `stage_status.test.tsx`
// pins what it looks like, this pins when it is there at all.
import { afterEach, expect, test } from 'bun:test';
import { type ViewerRendition } from '../../../../../src/schemas/settings';
import { registerDom } from '../../../test_dom';

registerDom();
const { cleanup, renderHook } = await import('@testing-library/react');
const { useNamedRendition } = await import('../named_rendition');

afterEach(cleanup);

const named = (chosen: ViewerRendition | null) =>
  renderHook<boolean, ViewerRendition | null>(useNamedRendition, { initialProps: chosen });

test('a pick is named', () => {
  const { result } = named('full');
  expect(result.current).toBe(true);
});

// The bug: opening a photograph clears the pick an effect after the stage has seen the
// previous photograph's, so the label was raised and then had only its timer cancelled.
// It sat over the next photograph naming a rendition nobody had asked for, for the rest of
// the visit - and going back out and in again showed nothing, the pick being null by then.
test('the label goes when the pick does', () => {
  const { rerender, result } = named('full');
  rerender(null);
  expect(result.current).toBe(false);
});
