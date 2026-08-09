import { describe, expect, it } from 'bun:test';
import { EditDocSchema, displaySize, neutralEdits, type EditDoc } from '../photo_edits';

function doc(over: Partial<EditDoc> = {}): EditDoc {
  return { ...neutralEdits(), ...over };
}

describe('displaySize', () => {
  it('leaves an uncropped photo at the file dimensions', () => {
    // Almost every photo in a library, so this is the case that has to be exact rather
    // than close: a rounding slip here would relayout the whole grid.
    expect(displaySize(6000, 4000, doc())).toEqual({ width: 6000, height: 4000 });
  });

  it('takes the crop as fractions of the frame, not as pixels', () => {
    const half = doc({ cropLeft: 0.25, cropRight: 0.75 });

    // The same document has to be right for a tile and for a native-resolution export,
    // which is the whole reason the rect is stored as fractions.
    expect(displaySize(6000, 4000, half)).toEqual({ width: 3000, height: 4000 });
    expect(displaySize(800, 533, half)).toEqual({ width: 400, height: 533 });
  });

  it('grows the frame to the straightened bounding box before cropping it', () => {
    const straightened = displaySize(1000, 1000, doc({ cropAngle: 45 }));

    // A square turned 45 degrees needs a box sqrt(2) wider to hold its corners. This is
    // why a straighten is not a no-op on an uncropped frame, and why the crop fractions
    // are defined against the rotated frame rather than the original.
    expect(straightened.width).toBe(1414);
    expect(straightened.height).toBe(1414);
  });

  it('reads the angle by its magnitude, so a straighten either way grows the frame', () => {
    expect(displaySize(1000, 1000, doc({ cropAngle: -45 }))).toEqual(
      displaySize(1000, 1000, doc({ cropAngle: 45 })),
    );
  });

  it('swaps the pair on a quarter turn, and leaves it on a half', () => {
    expect(displaySize(6000, 4000, doc({ rotate: 90 }))).toEqual({ width: 4000, height: 6000 });
    expect(displaySize(6000, 4000, doc({ rotate: 270 }))).toEqual({ width: 4000, height: 6000 });
    expect(displaySize(6000, 4000, doc({ rotate: 180 }))).toEqual({ width: 6000, height: 4000 });
  });

  it('applies the turn after the crop, not before it', () => {
    const cropped = doc({ cropBottom: 0.5, rotate: 90 });

    // Half the height, then turned: 6000x2000 becomes 2000x6000. Turning first would
    // have halved the width instead and given 3000x4000 - a different picture, and one
    // that looks plausible enough to ship.
    expect(displaySize(6000, 4000, cropped)).toEqual({ width: 2000, height: 6000 });
  });

  it('never reports a rendition of no pixels', () => {
    // The fractions are free to describe a rectangle narrower than a pixel at tile size,
    // and a zero-sized target is a failed encode rather than a small picture.
    const sliver = doc({ cropLeft: 0.5, cropRight: 0.5001 });

    expect(displaySize(800, 533, sliver).width).toBe(1);
  });
});

describe('EditDocSchema geometry', () => {
  it('defaults to the whole frame, which is what "no crop" means here', () => {
    const neutral = neutralEdits();

    // No `hasCrop` flag: the sidecar needs one because an undone crop leaves stale edges,
    // but this document is ours and a flag beside the rect would be free to disagree with
    // it.
    expect(neutral).toMatchObject({ cropLeft: 0, cropTop: 0, cropRight: 1, cropBottom: 1, cropAngle: 0, rotate: 0 });
    expect(displaySize(6000, 4000, neutral)).toEqual({ width: 6000, height: 4000 });
  });

  it('refuses a rotation that is not a quarter turn', () => {
    expect(EditDocSchema.safeParse({ rotate: 45 }).success).toBe(false);
    expect(EditDocSchema.safeParse({ rotate: 90 }).success).toBe(true);
  });

  it('refuses a crop edge outside the frame and an angle past the straighten range', () => {
    expect(EditDocSchema.safeParse({ cropRight: 1.5 }).success).toBe(false);
    expect(EditDocSchema.safeParse({ cropAngle: 90 }).success).toBe(false);
  });
});
