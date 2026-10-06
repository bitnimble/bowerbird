import { afterEach, beforeEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';
import type { RenderingIntent } from '../../../../../../src/schemas/rendering_intent';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { arriveDetailAt, fileOf, forgetFrames, holdDetailOf } = await import('./stage_frames');
const { paints } = await import('./stage_canvases');
const { PhotoStage } = await import('../photo_stage');
const { PhotoStageStrings } = await import('../photo_stage.strings');

// Frames run only when a test says so, which is what holds a replaced patch under its
// replacement long enough to look at.
const realFrame = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
const queued = new Map<number, FrameRequestCallback>();
let frameIds = 0;

beforeEach(() => {
  globalThis.requestAnimationFrame = (callback) => {
    queued.set(++frameIds, callback);
    return frameIds;
  };
  globalThis.cancelAnimationFrame = (id) => {
    queued.delete(id);
  };
});

afterEach(() => {
  cleanup();
  forgetFrames();
  paints.length = 0;
  queued.clear();
  globalThis.requestAnimationFrame = realFrame;
  globalThis.cancelAnimationFrame = realCancel;
});

async function frames(count: number): Promise<void> {
  for (let at = 0; at < count; at++) {
    await act(async () => {
      const due = [...queued.values()];
      queued.clear();
      for (const callback of due) callback(performance.now());
    });
  }
}

const SOURCE = 'raw.avif';

function stage(proof: RenderingIntent | null = null): JSX.Element {
  return (
    <PhotoStage
      photoKey="p1"
      pictures={[{ key: 'p1', sources: [SOURCE] }]}
      alt="photo"
      filename=""
      devicePeakNits={1000}
      proof={proof}
      onImageLoad={() => {}}
    />
  );
}

const settle = (): Promise<void> =>
  act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));

async function zoomAt(
  point: { clientX: number; clientY: number } = { clientX: 0, clientY: 0 },
): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('region', { name: PhotoStageStrings.stage() }), point);
  });
  await settle();
}

const details = (container: HTMLElement): HTMLCanvasElement[] => [
  ...container.querySelectorAll<HTMLCanvasElement>('canvas:not([role])'),
];

const detailPaints = (): number => paints.filter((label) => label === '').length;

const rectOf = (canvas: HTMLCanvasElement): string =>
  [canvas.style.left, canvas.style.top, canvas.style.width, canvas.style.height].join(' ');

test('zooming further draws the detail into a new canvas, over the painted one left where it was', async () => {
  // A stub stage of 200x20 fits this at a twentieth, so its 4px decode leaves every zoom to add.
  fileOf(SOURCE, { width: 4000, height: 400 });
  const { container } = render(stage());
  await act(async () => {});

  await zoomAt();
  await frames(4);
  const [first] = details(container);
  expect(first?.style.opacity).toBe('1');
  const painted = rectOf(first!);
  const before = detailPaints();

  await zoomAt();
  expect(detailPaints()).toBe(before + 1);
  const [under, over] = details(container);
  expect(under).toBe(first);
  expect(rectOf(first!)).toBe(painted);
  expect(over?.style.opacity).toBe('1');
  expect(rectOf(over!)).not.toBe(painted);

  await frames(4);
  expect(details(container)).toEqual([over!]);
});

test('at the edge of a frame an odd number of pixels across, a view held still stops drawing', async () => {
  fileOf(SOURCE, { width: 4001, height: 401 });
  const { container } = render(stage());
  await act(async () => {});

  // About the bottom right corner, so the view reaches the frame's last column and row.
  await zoomAt({ clientX: 200, clientY: 20 });
  const drawn = detailPaints();
  await settle();
  await frames(4);
  await settle();
  expect(detailPaints()).toBe(drawn);
  expect(details(container).filter((canvas) => canvas.style.opacity === '1')).toHaveLength(1);
});

test('a patch drawn for another proof is hidden until the one for this proof is drawn', async () => {
  fileOf(SOURCE, { width: 4000, height: 400 });
  const { container, rerender } = render(stage());
  await act(async () => {});
  await zoomAt();
  await frames(4);
  const [first] = details(container);

  holdDetailOf(SOURCE);
  rerender(stage('perceptual'));
  await act(async () => {});
  expect(first?.style.opacity).toBe('0');

  await act(async () => arriveDetailAt(SOURCE));
  const shown = details(container).filter((canvas) => canvas.style.opacity === '1');
  expect(shown).toHaveLength(1);
  expect(shown[0]).not.toBe(first);
});
