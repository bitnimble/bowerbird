// Flipping between two renditions the stage is already holding, which is an
// opacity change and nothing else. `step_exchange.test.tsx` pins what counts as a
// step; this pins that choosing a rendition cannot be one.
//
// The bug: the step a frame arrived with rode on the frame itself, and every
// rendition of a photograph was a frame of its own. Going back to the one the
// photo was stepped to at put the step back on an element that had lost it, and
// the browser replayed the entrance - a slide, in the direction of a step taken
// minutes ago, over a picture the page had decoded all along. The renditions
// share a picture, and the picture is what animates, so the flip does not reach
// the animated element at all.
import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { arriveDetailAt, fileOf, forgetFrames, holdDetailOf, released } = await import('./stage_frames');
const { PhotoStage } = await import('../photo_stage');
const { PhotoStageStrings } = await import('../photo_stage.strings');

const moved: HTMLElement[] = [];
Object.defineProperty(globalThis.HTMLElement.prototype, 'animate', {
  value(this: HTMLElement) {
    moved.push(this);
    return { cancel: () => undefined };
  },
  configurable: true,
  writable: true,
});

afterEach(() => {
  cleanup();
  forgetFrames();
  moved.length = 0;
});

const PHOTO = 'p1';
const RAW = 'raw.avif';
const JPEG = 'jpeg.jpg';

function stage(photoKey: string, sources: string[], frame: string, step: 'next' | null): JSX.Element {
  return (
    <PhotoStage
      photoKey={photoKey}
      pictures={[{ key: photoKey, sources, frame, alt: (source) => source }]}
      step={step}
      alt=""
      filename=""
      onImageLoad={() => {}}
    />
  );
}

// Each rendition is named for its source above, and the photo stepped away from is still
// mounted beside this one for a beat.
const frameOf = (container: HTMLElement, source: string): Element | null =>
  container.querySelector(`canvas[aria-label="${source}"]`);
const shown = (container: HTMLElement, source: string): boolean => {
  const frame = frameOf(container, source);
  return frame?.getAttribute('aria-hidden') === 'false' && frame.parentElement?.getAttribute('aria-hidden') !== 'true';
};

test('a rendition flipped back to does not replay the step the photo arrived by', async () => {
  // A photo before this one, so the next arrival is a step rather than the
  // stage's first frame.
  const { container, rerender } = render(stage('p0', ['first.avif'], 'first.avif', null));
  await act(async () => {});

  rerender(stage(PHOTO, [RAW], RAW, 'next'));
  await act(async () => {});
  expect(moved).toEqual([frameOf(container, RAW)!.parentElement!]);

  // Pressing I: the camera's JPEG mounts beside the render and takes the screen.
  rerender(stage(PHOTO, [RAW, JPEG], JPEG, 'next'));
  await act(async () => {});
  expect(shown(container, JPEG)).toBe(true);

  // And O again, which is the flip this is about. The renditions trade places between them;
  // the element the animation is on is not asked to move again.
  rerender(stage(PHOTO, [RAW, JPEG], RAW, 'next'));
  await act(async () => {});
  expect(shown(container, RAW)).toBe(true);
  expect(moved).toHaveLength(1);
});

// The stub stage is 200x20, so a file this shape fits it at a twentieth and its 4px decode
// leaves a zoom everything to add.
const LARGE = { width: 4000, height: 400 };

async function zoomedInto(
  sources: string[],
  frame: string,
): Promise<{ container: HTMLElement; flipTo: (frame: string) => Promise<void> }> {
  const { container, rerender } = render(stage(PHOTO, sources, frame, null));
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole('region', { name: PhotoStageStrings.stage() }));
  });
  expect(screen.getByRole('button', { pressed: true })).toBeTruthy();
  return {
    container,
    flipTo: async (next) => {
      rerender(stage(PHOTO, sources, next, null));
      await act(async () => {});
    },
  };
}

test('zoomed in, a rendition is revealed only once its detail is drawn', async () => {
  fileOf(RAW, LARGE);
  fileOf(JPEG, LARGE);
  holdDetailOf(JPEG);
  const { container, flipTo } = await zoomedInto([RAW, JPEG], RAW);
  expect(shown(container, RAW)).toBe(true);

  await flipTo(JPEG);
  expect(shown(container, RAW)).toBe(true);
  expect(shown(container, JPEG)).toBe(false);

  await act(async () => arriveDetailAt(JPEG));
  expect(shown(container, JPEG)).toBe(true);
  expect(shown(container, RAW)).toBe(false);
});

test('and the one flipped away from keeps its detail frame for the flip back', async () => {
  fileOf(RAW, LARGE);
  fileOf(JPEG, LARGE);
  const { container, flipTo } = await zoomedInto([RAW, JPEG], JPEG);
  // Unzoomed, a layer has nothing to add and lets its frame go; that is not this.
  released.length = 0;
  await flipTo(RAW);
  expect(shown(container, RAW)).toBe(true);

  expect(released).toEqual([]);
});

test('and one whose frame already holds every pixel of its file is revealed at once', async () => {
  fileOf(RAW, LARGE);
  holdDetailOf(JPEG);
  const { container, flipTo } = await zoomedInto([RAW, JPEG], RAW);

  await flipTo(JPEG);
  expect(shown(container, JPEG)).toBe(true);
});

test('both renditions are drawn inside the one picture', async () => {
  const { container, rerender } = render(stage(PHOTO, [RAW], RAW, null));
  await act(async () => {});
  rerender(stage(PHOTO, [RAW, JPEG], JPEG, null));
  await act(async () => {});

  const picture = frameOf(container, RAW)?.parentElement;
  expect(picture).toBeTruthy();
  expect(frameOf(container, JPEG)?.parentElement).toBe(picture);
});
