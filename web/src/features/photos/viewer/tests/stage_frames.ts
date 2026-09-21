// The decode a stage frame owns, stood in for. jsdom has no WebCodecs, no `createImageBitmap`
// and no canvas to draw into, so a real `stage_bitmaps` reports every frame missing and the
// stage never paints one - and what these tests are about is which frame is on screen.
//
// Imported for its side effect, and imported *before* `photo_stage`: the module registry is
// replaced as this evaluates, so anything already holding the real one keeps it.
import { mock } from 'bun:test';
import type { RequestActivity } from '../../../../../../src/schemas/request_activity';

const real = await import('../stage_bitmaps');

interface Frame {
  picture: null;
  close: () => void;
  closed: boolean;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
}

const decoded = new Map<string, Frame>();
const pending = new Map<string, () => void>();
const slow = new Set<string>();
const files = new Map<string, { width: number; height: number }>();
const pendingDetail = new Map<string, () => void>();
const slowDetail = new Set<string>();
const activities = new Map<string, RequestActivity>();
/** Every source a detail layer has given its frame up for, in order. */
export const released: string[] = [];

/** Holds this source's decode open until [`arriveAt`], for the tests about when a step moves. */
export function holdDecodeOf(source: string): void {
  slow.add(source);
}

export function arriveAt(source: string): void {
  pending.get(source)?.();
}

/**
 * The file behind a source, which the decode stands in at 4x3 whatever it is: the same shape
 * leaves the frame holding every pixel, and a bigger one leaves a zoom something to add.
 */
export function fileOf(source: string, size: { width: number; height: number }): void {
  files.set(source, size);
}

/** Holds this source's detail decode open until [`arriveDetailAt`]. */
export function holdDetailOf(source: string): void {
  slowDetail.add(source);
}

export function arriveDetailAt(source: string): void {
  pendingDetail.get(source)?.();
}

export function wasDecoded(source: string): boolean {
  return decoded.has(source);
}

export function activityOf(source: string): RequestActivity | undefined {
  return activities.get(source);
}

export function forgetFrames(): void {
  decoded.clear();
  pending.clear();
  slow.clear();
  files.clear();
  pendingDetail.clear();
  slowDetail.clear();
  activities.clear();
  released.length = 0;
}

void mock.module('../stage_bitmaps', () => ({
  ...real,
  decodeFrame: (source: string, _whole = false, activity: RequestActivity = 'interactive'): Promise<Frame> =>
    new Promise<Frame>((resolve) => {
      activities.set(source, activity);
      const settle = (): void => {
        const file = files.get(source) ?? { width: 4, height: 3 };
        const frame: Frame = {
          picture: null,
          close: () => undefined,
          closed: false,
          width: 4,
          height: 3,
          naturalWidth: file.width,
          naturalHeight: file.height,
        };
        decoded.set(source, frame);
        resolve(frame);
      };
      if (slow.has(source)) pending.set(source, settle);
      else settle();
    }),
  decodedFrame: (source: string): Frame | null => decoded.get(source) ?? null,
  decodeDetail: (source: string): Promise<Frame> =>
    new Promise<Frame>((resolve, reject) => {
      const settle = (): void => {
        const frame = decoded.get(source);
        if (frame == null) reject(new Error(`no frame for ${source}`));
        else resolve(frame);
      };
      if (slowDetail.has(source)) pendingDetail.set(source, settle);
      else settle();
    }),
  releaseDetail: (source: string): void => {
    released.push(source);
  },
  drawInto: (): Promise<void> => Promise.resolve(),
  keepOnly: (): void => undefined,
  releaseHolder: (): void => undefined,
}));
