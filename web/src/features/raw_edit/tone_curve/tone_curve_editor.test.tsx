import { afterEach, expect, test } from 'bun:test';
import { action } from 'mobx';
import { neutralEdits, type ToneCurve } from '../../../../../src/schemas/photo_edits';
import { registerDom } from '../../../test_dom';
import { EditStore } from '../edit/edit_store';
import { StageStore } from '../stage/stage_store';

registerDom();
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { ToneCurveEditor } = await import('./tone_curve_editor');

afterEach(cleanup);

const CAMERA: ToneCurve = [[0, 0.1], [0.5, 0.55], [1, 1]];

function open(toneCurve: ToneCurve | null = null, profile: 'matched' | 'none' = 'matched', known = true): {
  calls: { kind: string; points: ToneCurve | null }[];
  edit: EditStore;
} {
  const edit = new EditStore();
  const stage = new StageStore(edit);
  edit.doc = { ...neutralEdits(), toneCurve, colourProfile: profile };
  stage.status = 'live';
  stage.detail = known ? [20, 70] : null;
  stage.cameraCurve = CAMERA;
  const calls: { kind: string; points: ToneCurve | null }[] = [];
  const record = action((kind: string, points: ToneCurve | null): void => {
    if (edit.doc != null) edit.doc = { ...edit.doc, toneCurve: points };
    calls.push({ kind, points });
  });
  render(<ToneCurveEditor edit={edit} stage={stage} presenter={{
    previewToneCurve: (points) => record('preview', points),
    settleToneCurve: (points) => record('settle', points),
  }} />);
  return { calls, edit };
}

function plot(): SVGSVGElement {
  const svg = screen.getByRole('group', { name: 'Tone curve' }) as unknown as SVGSVGElement;
  Object.defineProperty(svg, 'getBoundingClientRect', {
    value: () => ({ left: 0, top: 0, width: 100, height: 100 }),
  });
  return svg;
}

test('camera curve supplies named points until document stores one', () => {
  open();
  screen.getByRole('button', { name: 'Black point, 0% input, 10% output' });
  screen.getByRole('button', { name: 'Curve point 1, 50% input, 55% output' });
  screen.getByRole('button', { name: 'White point, 100% input, 100% output' });
  expect(screen.queryByRole('button', { name: 'Reset tone curve' })).toBeNull();
});

test('profile without a match shows identity', () => {
  open(null, 'none');
  screen.getByRole('button', { name: 'Black point, 0% input, 0% output' });
  screen.getByRole('button', { name: 'White point, 100% input, 100% output' });
  expect(screen.queryByRole('button', { name: /Curve point/ })).toBeNull();
});

test('plot stays blank and disabled until header arrives', () => {
  open(null, 'matched', false);
  expect(screen.getByRole('group', { name: 'Tone curve' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.queryByRole('button', { name: /point/i })).toBeNull();
});

test('keyboard moves and removes interior point; endpoints cannot be removed', () => {
  const { calls } = open(CAMERA);
  const middle = screen.getByRole('button', { name: /Curve point 1/ });
  fireEvent.keyDown(middle, { key: 'ArrowUp' });
  expect(calls).toEqual([{ kind: 'settle', points: [[0, 0.1], [0.5, 0.56], [1, 1]] }]);
  fireEvent.keyDown(middle, { key: 'Delete' });
  expect(calls.at(-1)).toEqual({ kind: 'settle', points: [[0, 0.1], [1, 1]] });
  fireEvent.keyDown(screen.getByRole('button', { name: /Black point/ }), { key: 'Backspace' });
  fireEvent.keyDown(screen.getByRole('button', { name: /White point/ }), { key: 'Delete' });
  expect(calls).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Reset tone curve' }));
  expect(calls.at(-1)).toEqual({ kind: 'settle', points: null });
});

test('right click removes interior point, never endpoints, and suppresses plot menu', () => {
  const { calls } = open(CAMERA);
  expect(fireEvent.contextMenu(screen.getByRole('button', { name: /Curve point 1/ }))).toBe(false);
  expect(calls).toEqual([{ kind: 'settle', points: [[0, 0.1], [1, 1]] }]);
  expect(fireEvent.contextMenu(screen.getByRole('button', { name: /Black point/ }))).toBe(false);
  expect(fireEvent.contextMenu(screen.getByRole('button', { name: /White point/ }))).toBe(false);
  expect(fireEvent.contextMenu(screen.getByRole('group', { name: 'Tone curve' }))).toBe(false);
  expect(calls).toHaveLength(1);
});

test('plot press inserts a point and release settles once', () => {
  const { calls } = open(null, 'none');
  const svg = plot();
  fireEvent.pointerDown(svg, { pointerId: 2, isPrimary: false, button: 0, clientX: 25, clientY: 75 });
  expect(calls).toEqual([]);
  fireEvent.pointerDown(svg, { pointerId: 1, isPrimary: true, button: 0, clientX: 25, clientY: 75 });
  expect(calls).toEqual([{ kind: 'preview', points: [[0, 0], [0.25, 0.25], [1, 1]] }]);
  fireEvent.pointerDown(svg, { pointerId: 3, isPrimary: true, button: 0, clientX: 75, clientY: 25 });
  fireEvent.pointerMove(svg, { pointerId: 3, isPrimary: true, clientX: 80, clientY: 20 });
  fireEvent.pointerUp(svg, { pointerId: 3, isPrimary: true });
  expect(calls).toHaveLength(1);
  fireEvent.pointerUp(svg, { pointerId: 1, isPrimary: true });
  expect(calls).toEqual([
    { kind: 'preview', points: [[0, 0], [0.25, 0.25], [1, 1]] },
    { kind: 'settle', points: [[0, 0], [0.25, 0.25], [1, 1]] },
  ]);
});

test('dragging an interior point off the plot removes it', () => {
  const { calls } = open(CAMERA);
  const svg = plot();
  fireEvent.pointerDown(screen.getByRole('button', { name: /Curve point 1/ }), {
    pointerId: 1, isPrimary: true, button: 0, clientX: 50, clientY: 45,
  });
  fireEvent.pointerMove(svg, { pointerId: 1, isPrimary: true, clientX: 130, clientY: 45 });
  expect(calls).toEqual([{ kind: 'preview', points: [[0, 0.1], [1, 1]] }]);
  fireEvent.pointerUp(svg, { pointerId: 1, isPrimary: true });
  expect(calls.at(-1)).toEqual({ kind: 'settle', points: [[0, 0.1], [1, 1]] });
});

test('pointercancel restores starting curve without settling', () => {
  const { calls, edit } = open();
  const svg = plot();
  fireEvent.pointerDown(svg, { pointerId: 1, isPrimary: true, button: 0, clientX: 25, clientY: 75 });
  fireEvent.pointerMove(svg, { pointerId: 1, isPrimary: true, clientX: 30, clientY: 65 });
  fireEvent.pointerCancel(svg, { pointerId: 1, isPrimary: true });
  expect(calls.map(({ kind }) => kind)).toEqual(['preview', 'preview', 'preview']);
  expect(calls.at(-1)).toEqual({ kind: 'preview', points: null });
  expect(edit.doc?.toneCurve).toBeNull();
  expect(svg.hasPointerCapture(1)).toBe(false);
});

test('pointercancel restores a stored curve without settling', () => {
  const { calls, edit } = open(CAMERA);
  const svg = plot();
  fireEvent.pointerDown(screen.getByRole('button', { name: /Curve point 1/ }), {
    pointerId: 1, isPrimary: true, button: 0, clientX: 50, clientY: 45,
  });
  fireEvent.pointerMove(svg, { pointerId: 1, isPrimary: true, clientX: 60, clientY: 35 });
  fireEvent.pointerCancel(svg, { pointerId: 1, isPrimary: true });
  expect(calls.at(-1)).toEqual({ kind: 'preview', points: CAMERA });
  expect(calls.some(({ kind }) => kind === 'settle')).toBe(false);
  expect(edit.doc?.toneCurve).toEqual(CAMERA);
});
