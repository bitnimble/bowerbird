// What counts as a step, which is the whole of when the stage animates. A run mounts its
// neighbours, so the picture stepped to already has its raster and there is no arrival to
// hang the animation on - the exchange is the event, and this pins the three moves that are
// not one: the stage's first picture, a rendition swapped underneath the one on screen, and
// a photograph held over into the next round.
import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';
import type { StagePicture } from '../../viewer/photo_stage';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { arriveAt, forgetFrames, holdDecodeOf, wasDecoded } = await import('../../viewer/tests/stage_frames');
const { PhotoStage } = await import('../../viewer/photo_stage');

// jsdom does not animate, so the movement is recorded rather than run: what this pins about it
// is *when* it is asked for, which is the frame the picture it moves is drawn in.
const moved: { element: HTMLElement; from: Keyframe | undefined }[] = [];
Object.defineProperty(globalThis.HTMLElement.prototype, 'animate', {
  value(this: HTMLElement, frames: Keyframe[]) {
    moved.push({ element: this, from: frames[0] });
    return { cancel: () => undefined };
  },
  configurable: true,
  writable: true,
});
globalThis.requestAnimationFrame = ((run: FrameRequestCallback) => setTimeout(() => run(0), 0)) as never;

afterEach(() => {
  cleanup();
  forgetFrames();
  moved.length = 0;
});

/** `photo_stage`'s own, which is what the neighbours wait out. */
const STEP_MS = 130;

const src = (id: string): string => `${id}.avif`;
const of = (id: string): StagePicture => ({ key: id, sources: [src(id)], alt: id });

function stage(photoKey: string, pictures: StagePicture[], showing: number, step: 'next' | 'prev' | 'fade' | null): JSX.Element {
  return (
    <PhotoStage photoKey={photoKey} pictures={pictures} showing={showing} step={step} alt="" filename="" onImageLoad={() => {}} />
  );
}

/** The photograph's frame, on screen or not: a hidden element has no accessible name to query by. */
const frameOf = (id: string): HTMLElement | null => document.querySelector(`[role="img"][aria-label="${id}"]`);
/** On screen: its frame is the one shown, in a picture that is not hidden. */
const shown = (id: string): boolean => screen.queryByRole('img', { name: id }) != null;
const leaving = (id: string): boolean => frameOf(id)?.parentElement?.getAttribute('aria-hidden') === 'true';
/** Where the step started this photograph's picture from, if it moved at all. */
const stepOf = (id: string): Keyframe | undefined =>
  moved.find((move) => move.element === frameOf(id)?.parentElement)?.from;

const run = ['p0', 'p1', 'p2'].map(of);

// The neighbours are mounted one at a time and only once the picture asked for has been up
// long enough to have arrived, so a test about the frame beside the one on screen waits that
// out. Two turns, not one: the first is what paints, and `STEP_MS` is counted from there.
const settle = async (): Promise<void> => {
  await act(async () => {});
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, STEP_MS + 30));
  });
};

test("the stage's first picture came from nowhere, so it holds its place", async () => {
  render(stage('p0', run, 0, 'next'));
  await act(async () => {});

  expect(shown('p0')).toBe(true);
  expect(stepOf('p0')).toBeUndefined();
});

test('stepping to a neighbour the stage is already holding is the step', async () => {
  const { rerender } = render(stage('p0', run, 0, null));
  await settle();
  // Held, decoded, and not on screen: this is what makes the step free.
  expect(frameOf('p1')).not.toBeNull();
  expect(wasDecoded(src('p1'))).toBe(true);
  expect(shown('p1')).toBe(false);

  rerender(stage('p1', run, 1, 'next'));
  await act(async () => {});

  expect(shown('p1')).toBe(true);
  expect(stepOf('p1')).toEqual({ translate: '22px' });
  expect(leaving('p0')).toBe(true);
});

test('trading two pictures of one stage is a flip, not a step', async () => {
  // Stack triage's A/B, where the reader is comparing them in place.
  const round = [of('a'), of('b')];
  const { rerender } = render(stage('a:b', round, 0, 'fade'));
  await act(async () => {});

  rerender(stage('a:b', round, 1, 'fade'));
  await act(async () => {});

  expect(shown('b')).toBe(true);
  expect(stepOf('b')).toBeUndefined();
});

test('a photograph held over into the next round did not arrive', async () => {
  // Stack triage's exchange: one side is replaced and the winner keeps its slot, which is
  // the one frame the round must leave alone.
  const round = [of('a'), of('b')];
  const { rerender } = render(stage('a:b', round, 0, 'fade'));
  await act(async () => {});

  rerender(stage('a:c', [of('a'), of('c')], 0, 'fade'));
  await act(async () => {});

  expect(stepOf('a')).toBeUndefined();
});

test('flipping either way after a winner is held over still shows the frame flipped to', async () => {
  // The round the winner is carried into leaves the stage showing the same picture under a
  // new key, so what it was last showing has to be recorded against the *new* round: read
  // back against the old one, the flip out of it reads as a step and the flip back into it
  // is refused, leaving the picture on screen hidden by the exit that step created.
  const { rerender } = render(stage('a:b', [of('a'), of('b')], 0, 'fade'));
  await act(async () => {});

  rerender(stage('a:c', [of('a'), of('c')], 0, 'fade'));
  await act(async () => {});
  rerender(stage('a:c', [of('a'), of('c')], 1, 'fade'));
  await act(async () => {});
  expect(shown('c')).toBe(true);

  rerender(stage('a:c', [of('a'), of('c')], 0, 'fade'));
  await act(async () => {});
  expect(shown('a')).toBe(true);
});

// The direction lands a render after the route does, so a step is two commits here. What
// the reader must not see in the first of them is the photograph they stepped away from:
// it is hidden by leaving itself, which is a resting state and not somewhere an animation
// puts it - so it holds in that commit, and holds under reduced motion.
test('the photograph stepped away from is marked gone from the commit the step lands in', async () => {
  const { rerender } = render(stage('p0', run, 0, null));
  await act(async () => {});

  rerender(stage('p1', run, 1, null));
  await act(async () => {});
  expect(leaving('p0')).toBe(true);

  rerender(stage('p1', run, 1, 'next'));
  await act(async () => {});
  expect(leaving('p0')).toBe(true);
  expect(stepOf('p1')).toEqual({ translate: '22px' });
});

// Leaving hides a picture outright, so it cannot go on the one still drawing the screen:
// stepping to a photograph this stage was not holding is covered by the frame already up,
// which lives in the picture being stepped away from. Hidden on the step alone, that cover
// goes with it and the reader gets the stage's own background until the new photograph
// decodes.
test('the picture drawing the screen is not hidden while the next one is still arriving', async () => {
  const { rerender } = render(stage('p0', [of('p0')], 0, null));
  await act(async () => {});
  expect(shown('p0')).toBe(true);

  // A photograph the run was not holding: nothing of it has decoded yet.
  rerender(stage('p9', [of('p0'), of('p9')], 1, 'next'));
  expect(shown('p0')).toBe(true);

  // And once it has arrived, the one it replaced goes.
  await act(async () => {});
  expect(shown('p9')).toBe(true);
  expect(leaving('p0')).toBe(true);
});

// The move is worth nothing if it runs while the photograph is still arriving: a decode
// resolving is not a paint, and on a busy main thread a step animated when the exchange
// formed is over before the picture is drawn - the reader catches its tail, or none of it.
test('the step is not moved until the picture it moves is the one on screen', async () => {
  holdDecodeOf(src('p9'));

  const { rerender } = render(stage('p0', [of('p0')], 0, null));
  await act(async () => {});

  // Stepped to, and still decoding: nothing has moved yet.
  rerender(stage('p9', [of('p0'), of('p9')], 1, 'next'));
  await act(async () => {});
  expect(moved).toEqual([]);

  await act(async () => {
    arriveAt(src('p9'));
    // The move is asked for on a rendering frame, so it is a turn of the loop behind the
    // decode rather than in the same one.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(moved).toHaveLength(1);
  expect(stepOf('p9')).toEqual({ translate: '22px' });
});

test('a neighbour dropped from the run is not held up as though it had been on screen', async () => {
  // The run slides, so each step drops one photograph off the trailing edge. That frame was
  // never visible, and held under the next one it is drawn opaque at the bottom of the stack -
  // what appears to slide away on the next step is then a photograph two back.
  const { rerender } = render(stage('p1', run, 1, null));
  await act(async () => {});

  rerender(stage('p2', ['p1', 'p2', 'p3'].map(of), 1, 'next'));
  await act(async () => {});

  expect(frameOf('p0')).toBeNull();
});
