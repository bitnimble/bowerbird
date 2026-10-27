import { afterEach, beforeEach, expect, test } from 'bun:test';
import { useRef } from 'react';
import { registerDom } from '../../../../test_dom';
import type { Size } from '../zoom_pan';

registerDom();
const { act, cleanup, fireEvent, render } = await import('@testing-library/react');
const { useZoomPan } = await import('../zoom_pan');

const FRAME: Size = { width: 2000, height: 200 };

let frames: FrameRequestCallback[] = [];
const realFrame = globalThis.requestAnimationFrame;

beforeEach(() => {
  frames = [];
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
});

afterEach(() => {
  cleanup();
  globalThis.requestAnimationFrame = realFrame;
});

function flushFrame(): void {
  const due = frames;
  frames = [];
  act(() => due.forEach((callback) => callback(0)));
}

function Probe({ seen }: { seen: { scale: number } }): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const zoom = useZoomPan(viewport, viewport, FRAME);
  seen.scale = zoom.view.scale;
  return <div ref={viewport} style={{ width: 200, height: 20 }} />;
}

function open(): { frame: HTMLElement; seen: { scale: number }; measures: () => number } {
  const seen = { scale: 1 };
  const { container } = render(<Probe seen={seen} />);
  const frame = container.firstElementChild as HTMLElement;
  let measured = 0;
  const measure = frame.getBoundingClientRect.bind(frame);
  frame.getBoundingClientRect = () => {
    measured += 1;
    return measure();
  };
  return { frame, seen, measures: () => measured };
}

const wheel = (frame: HTMLElement, deltaY: number): void => {
  fireEvent.wheel(frame, { deltaY, clientX: 100, clientY: 10 });
};

test('a frame of trackpad wheel events zooms once, measuring the stage once', () => {
  const { frame, seen, measures } = open();

  wheel(frame, -100);
  wheel(frame, -100);
  wheel(frame, -100);
  expect(seen.scale).toBe(1);

  flushFrame();
  expect(seen.scale).toBeCloseTo(Math.exp(0.45), 5);

  wheel(frame, -100);
  flushFrame();
  expect(seen.scale).toBeCloseTo(Math.exp(0.6), 5);
  expect(measures()).toBe(1);
});

test('a trackpad pinch zooms twice as far as the same scroll', () => {
  const { frame, seen } = open();

  fireEvent.wheel(frame, { deltaY: -100, ctrlKey: true, clientX: 100, clientY: 10 });
  flushFrame();

  expect(seen.scale).toBeCloseTo(Math.exp(0.3), 5);
});

test('a large wheel delta zooms out by a factor rather than snapping to fitted', () => {
  const { frame, seen } = open();

  wheel(frame, -1000);
  flushFrame();
  wheel(frame, 800);
  flushFrame();

  expect(seen.scale).toBeCloseTo(Math.exp(0.3), 5);
});
