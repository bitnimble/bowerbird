// Painting a stroke on the picture, against a presenter that only records what it was handed.
import { afterEach, describe, expect, test } from 'bun:test';
import { neutralEdits } from '../../../../../../src/schemas/photo_edits';
import { registerDom } from '../../../../test_dom';
import { FITTED } from '../../../photos/viewer/zoom_pan';
import { EditStore } from '../../edit/edit_store';
import { StageStore } from '../../stage/stage_store';
import type { ReflectionPresenter } from '../reflection_presenter';
import { ReflectionStore, type StrokeOutline } from '../reflection_store';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { ReflectionOverlay } = await import('../reflection_overlay');

afterEach(cleanup);

/** The 4000x3000 output fitted to a 400x300 box, a tenth of a pixel per pixel. */
const BOX = { width: 400, height: 300 };
const NATURAL = { width: 4000, height: 3000 };

/** jsdom has no `PointerEvent` and no `offsetX`, so a `MouseEvent` wearing the fields read. */
function pointer(type: string, x: number, y: number): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, button: 0 });
  Object.defineProperties(event, {
    isPrimary: { value: true },
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
    offsetX: { value: x },
    offsetY: { value: y },
  });
  return event;
}

function open({
  brushing = true,
  outlines = [],
}: { brushing?: boolean; outlines?: StrokeOutline[] } = {}): { painted: unknown[] } {
  const edit = new EditStore();
  const stage = new StageStore(edit);
  const store = new ReflectionStore(edit, stage);
  edit.doc = { ...neutralEdits(), reflectionRemoval: true };
  stage.width = NATURAL.width;
  stage.height = NATURAL.height;
  stage.status = 'live';
  store.brushing = brushing;
  store.outlines = outlines;
  const painted: unknown[] = [];
  const presenter = {
    paint: (points: unknown) => {
      painted.push(points);
      return Promise.resolve();
    },
  } as unknown as ReflectionPresenter;
  render(
    <ReflectionOverlay
      store={store}
      presenter={presenter}
      view={FITTED}
      box={BOX}
      natural={NATURAL}
    />,
  );
  return { painted };
}

describe('the reflection brush on the stage', () => {
  test('takes no pointer until the brush is on', () => {
    open({ brushing: false });
    expect(screen.queryByRole('group', { name: 'Reflection strokes' })).toBeNull();
  });

  test('hands a drag over as fractions of the output, drawn at the brush size as it goes', () => {
    const { painted } = open();
    const surface = screen.getByRole('group', { name: 'Reflection strokes' });
    act(() => {
      surface.dispatchEvent(pointer('pointerdown', 100, 75));
      surface.dispatchEvent(pointer('pointermove', 200, 75));
    });
    // 5% of the 4000 pixel long edge either side of the line, at a tenth of a pixel per pixel.
    expect(
      screen.getByRole('img', { name: 'Stroke being drawn' }).getAttribute('stroke-width'),
    ).toBe('40');

    act(() => {
      surface.dispatchEvent(pointer('pointerup', 300, 150));
    });
    expect(painted).toEqual([
      [
        { x: 0.25, y: 0.25 },
        { x: 0.5, y: 0.25 },
        { x: 0.75, y: 0.5 },
      ],
    ]);
    expect(screen.queryByRole('img', { name: 'Stroke being drawn' })).toBeNull();
  });

  test('shows the strokes kept, each by what it marks', () => {
    open({
      outlines: [
        { kind: 'remove', radius: 100, points: [{ x: 0.1, y: 0.1 }] },
        {
          kind: 'keep',
          radius: 50,
          points: [
            { x: 0.5, y: 0.5 },
            { x: 0.6, y: 0.5 },
          ],
        },
      ],
    });
    const removed = screen.getByRole('img', { name: 'Area to remove 1' });
    // A lone point is drawn as a zero-length line, which its round cap makes a dot.
    expect(removed.getAttribute('points')).toBe('40,30 40,30');
    expect(removed.getAttribute('stroke-width')).toBe('20');
    expect(screen.getByRole('img', { name: 'Area to keep 2' }).getAttribute('points')).toBe(
      '200,150 240,150',
    );
  });
});
