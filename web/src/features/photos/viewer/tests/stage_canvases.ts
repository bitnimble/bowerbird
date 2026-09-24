// The paint, stood in for: a real one hands the canvas to the GPU thread, which spawns the app's
// worker and its wasm module inside the test runner.
//
// Imported for its side effect, before whatever paints, as `stage_frames.ts` is.
import { mock } from 'bun:test';

const real = await import('../stage_canvas');

void mock.module('../stage_canvas', () => ({
  ...real,
  stageCanvases: {
    paint: (): Promise<void> => Promise.resolve(),
    paintMasked: (): Promise<boolean> => Promise.resolve(true),
    release: (): void => undefined,
  },
}));
