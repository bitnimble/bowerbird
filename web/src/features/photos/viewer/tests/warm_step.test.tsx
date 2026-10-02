// Stepping onto a photograph the stage is already holding repaints nothing: its canvas, and its
// neighbours', already hold what they draw.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';
import type { RenderingIntent } from '../../../../../../src/schemas/rendering_intent';

registerDom();
const { act, cleanup, render, waitFor } = await import('@testing-library/react');
const { forgetFrames } = await import('./stage_frames');
const { paints } = await import('./stage_canvases');
const { PhotoStage } = await import('../photo_stage');

const loads: string[] = [];

// The paint stand-in is one module for every file in the run.
beforeEach(() => {
  paints.length = 0;
  loads.length = 0;
});

afterEach(() => {
  cleanup();
  forgetFrames();
});

function stage(photoKey: string, proof: RenderingIntent | null = null): JSX.Element {
  const pictures = ['a', 'b'].map((key) => ({ key, sources: [key], alt: key }));
  return (
    <PhotoStage
      photoKey={photoKey}
      pictures={pictures}
      showing={pictures.findIndex((each) => each.key === photoKey)}
      step="next"
      alt=""
      filename=""
      proof={proof}
      devicePeakNits={1000}
      onImageLoad={(source) => loads.push(source)}
    />
  );
}

async function bothHeld(): Promise<(photoKey: string, proof?: RenderingIntent) => Promise<void>> {
  const { rerender } = render(stage('a'));
  await waitFor(() => expect(paints).toEqual(['a', 'b']));
  return async (photoKey, proof) => {
    rerender(stage(photoKey, proof));
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 200)));
  };
}

test('going back and forth between two held photographs paints each once', async () => {
  const stepTo = await bothHeld();
  for (const photoKey of ['b', 'a', 'b', 'a']) await stepTo(photoKey);

  expect(paints).toEqual(['a', 'b']);
});

test('and each step still reports both frames under the photograph stepped to', async () => {
  const stepTo = await bothHeld();
  loads.length = 0;
  await stepTo('b');

  expect([...loads].sort()).toEqual(['a', 'b']);
});

test('a proof changing repaints them', async () => {
  const stepTo = await bothHeld();
  await stepTo('a', 'perceptual');

  expect([...paints].sort()).toEqual(['a', 'a', 'b', 'b']);
});
