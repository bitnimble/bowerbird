import { expect, test } from 'bun:test';
import { LONG_PRESS_MS, TouchDrag, type TouchDragHost, type TouchTrack } from '../touch_drag';

const TRACK: TouchTrack = {
  from: 50,
  min: 0,
  max: 100,
  step: 1,
  left: 0,
  width: 200,
  onThumb: true,
};

function recorded(): { calls: string[]; host: TouchDragHost } {
  const calls: string[] = [];
  return {
    calls,
    host: {
      start: () => calls.push('start'),
      change: (value) => calls.push(`change ${value}`),
      commit: (value) => calls.push(`commit ${value}`),
    },
  };
}

test('a swipe down the thumb scrolls, and never starts the slider', () => {
  const drag = new TouchDrag();
  const { calls, host } = recorded();
  drag.down(1, 100, 10, TRACK, host);
  drag.move(1, 103, 30);
  drag.move(1, 140, 30);
  drag.end(1);
  expect(calls).toEqual([]);
});

test('a sideways drag past the slop starts the slider, following the thumb from where it was', () => {
  const drag = new TouchDrag();
  const { calls, host } = recorded();
  drag.down(1, 100, 10, TRACK, host);
  drag.move(1, 106, 12);
  expect(calls).toEqual([]);
  drag.move(1, 120, 14);
  drag.move(1, 300, 14);
  drag.end(1);
  expect(calls).toEqual(['start', 'change 60', 'change 100', 'commit 100']);
});

test('a sideways drag on the track starts at the finger', () => {
  const drag = new TouchDrag();
  const { calls, host } = recorded();
  drag.down(1, 20, 10, { ...TRACK, onThumb: false }, host);
  drag.move(1, 40, 10);
  drag.end(1);
  expect(calls).toEqual(['start', 'change 20', 'commit 20']);
});

test('resting on the thumb starts the slider, so it can then move less than the slop', async () => {
  const drag = new TouchDrag();
  const { calls, host } = recorded();
  drag.down(1, 100, 10, TRACK, host);
  await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 20));
  expect(drag.dragging).toBe(true);
  drag.move(1, 104, 10);
  drag.end(1);
  expect(calls).toEqual(['start', 'change 52', 'commit 52']);
});

test('resting on the thumb and letting go leaves an off-step value where it was', async () => {
  const drag = new TouchDrag();
  const { calls, host } = recorded();
  drag.down(1, 100, 10, { ...TRACK, from: 50.4 }, host);
  await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 20));
  drag.end(1);
  expect(calls).toEqual(['start']);
});

test("another finger's moves and lifts are not this press's", () => {
  const drag = new TouchDrag();
  const { calls, host } = recorded();
  drag.down(1, 100, 10, TRACK, host);
  drag.move(2, 160, 10);
  drag.end(2);
  expect(calls).toEqual([]);
  drag.move(1, 120, 10);
  drag.end(1);
  expect(calls).toEqual(['start', 'change 60', 'commit 60']);
});

test('a press forgotten before it rests long enough never starts', async () => {
  const drag = new TouchDrag();
  const { calls, host } = recorded();
  drag.down(1, 100, 10, TRACK, host);
  drag.forget();
  drag.down(2, 100, 10, { ...TRACK, onThumb: false }, host);
  await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 20));
  expect(calls).toEqual([]);
  expect(drag.dragging).toBe(false);
});

test('resting on the track starts nothing', async () => {
  const drag = new TouchDrag();
  const { calls, host } = recorded();
  drag.down(1, 20, 10, { ...TRACK, onThumb: false }, host);
  await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 20));
  drag.end(1);
  expect(calls).toEqual([]);
});
