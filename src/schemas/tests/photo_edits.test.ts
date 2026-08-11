import { describe, expect, it } from 'bun:test';
import {
  EditDocSchema,
  applyEdits,
  diffEdits,
  neutralEdits,
  sameEditValue,
  type EditDoc,
} from '../photo_edits';
import { displaySize } from '../display_size';

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

  it('takes a correction of exactly eight numbers, or none', () => {
    const eight = [1, 0, 0, 0, 1, 0, 0, 0.2];
    expect(EditDocSchema.safeParse({ keystone: eight }).success).toBe(true);
    expect(EditDocSchema.safeParse({ keystone: null }).success).toBe(true);
    // The ninth is always 1 and is not stored; a matrix that carries it is a different
    // convention, and reading it as this one bends the photograph.
    expect(EditDocSchema.safeParse({ keystone: [...eight, 1] }).success).toBe(false);
    expect(EditDocSchema.safeParse({ keystone: eight.slice(1) }).success).toBe(false);
    expect(neutralEdits().keystone).toBeNull();
  });

  it('takes no more guides than the geometry has axes for', () => {
    const guide = { x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 };
    expect(EditDocSchema.safeParse({ keystoneGuides: [guide, guide, guide, guide] }).success).toBe(true);
    expect(EditDocSchema.safeParse({ keystoneGuides: Array(5).fill(guide) }).success).toBe(false);
    expect(neutralEdits().keystoneGuides).toEqual([]);
  });
});

// A delta is what undo steps through, so what it can and cannot see is what a reader can and
// cannot get back. Two of these are regressions: the fields the perspective tool added are the
// document's first arrays, and `.loose()` is a promise about a newer build's parameters that a
// diff blind to them quietly broke.
describe('what a delta carries', () => {
  it('sees nothing in a document that was only re-parsed', () => {
    // Every read parses, and zod hands back a *new* array for a defaulted one - so an identity
    // compare called every retried save a change and appended a delta undoing nothing.
    expect(diffEdits(neutralEdits(), neutralEdits())).toBeNull();
  });

  it('carries the correction and the guides that describe it, both ways', () => {
    const from = neutralEdits();
    const to = doc({
      keystone: [1.98, 0, 0, 0, 2.52, -0.27, 0, 1.09],
      keystoneGuides: [{ x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 }],
    });

    const delta = diffEdits(from, to);
    expect(delta).not.toBeNull();
    expect(applyEdits(from, delta!.to)).toEqual(to);
    expect(applyEdits(to, delta!.from)).toEqual(from);
  });

  it('sees a parameter this build has never heard of', () => {
    // `.loose()` keeps such a key through a round trip; a diff that only walked this build's own
    // fields answered "nothing moved" to a save that moved one - 200, no write, and a client
    // that marks itself clean - and left it out of the delta when something else moved beside
    // it, so undo produced a document that never existed.
    const from = { ...neutralEdits(), filmGrain: 30 } as unknown as EditDoc;
    const to = { ...neutralEdits(), filmGrain: 60 } as unknown as EditDoc;

    const delta = diffEdits(from, to);
    expect(delta?.to).toEqual({ filmGrain: 60 });
    expect(delta?.from).toEqual({ filmGrain: 30 });
  });
});

describe('comparing one field of a document', () => {
  it('holds a list apart from a record of the same numbers', () => {
    // An array's own keys are its indices, so the object arm would call these the same thing.
    expect(sameEditValue([], {})).toBe(false);
    expect(sameEditValue([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameEditValue([1, 2], [1, 2])).toBe(true);
  });

  it('reads two guides as the same only when every corner agrees', () => {
    const guide = { x1: 0.2, y1: 0.05, x2: 0.3, y2: 0.95 };
    expect(sameEditValue([guide], [{ ...guide }])).toBe(true);
    expect(sameEditValue([guide], [{ ...guide, y2: 0.94 }])).toBe(false);
    expect(sameEditValue(null, null)).toBe(true);
    expect(sameEditValue(null, 0)).toBe(false);
  });
});
