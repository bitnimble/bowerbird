// The pill in the corner of the photograph: silent unless there is something to say, and
// pinned to the viewport rather than drawn inside the picture, so a pan slides the frame
// under it instead of carrying it off the screen. Where it sits is `letterboxOf`.
import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';

registerDom();
const { cleanup, render, screen } = await import('@testing-library/react');
await import('./stage_frames');
const { PhotoStage } = await import('../photo_stage');
const { PhotoStageStrings } = await import('../photo_stage.strings');

afterEach(cleanup);

const PICTURE = [{ key: 'p1', sources: ['p1.avif'] }];

function stage(status: { label: string; busy: boolean } | null): JSX.Element {
  return <PhotoStage photoKey="p1" pictures={PICTURE} status={status} alt="" filename="" onImageLoad={() => {}} />;
}

test('nothing to say, nothing on screen', () => {
  render(stage(null));
  expect(screen.queryByRole('status')).toBeNull();
});

test('a build says so, and is a wait', () => {
  render(stage({ label: 'Rendering', busy: true }));
  const pill = screen.getByRole('status');
  expect(pill.textContent).toBe('Rendering');
  expect(pill.getAttribute('aria-busy')).toBe('true');
});

test('a rendition names itself, and is not a wait', () => {
  render(stage({ label: 'Rendered RAW', busy: false }));
  const pill = screen.getByRole('status');
  expect(pill.textContent).toBe('Rendered RAW');
  expect(pill.getAttribute('aria-busy')).toBe('false');
});

// Not inside a picture, which is what carries the zoom and pan transform: inside one the pill
// would slide off the screen with the photograph.
test('the pill is pinned to the viewport, not to the picture', () => {
  render(stage({ label: 'Rendering', busy: true }));
  const pill = screen.getByRole('status');
  expect(pill.parentElement).toBe(screen.getByRole('region', { name: PhotoStageStrings.stage() }));
});
