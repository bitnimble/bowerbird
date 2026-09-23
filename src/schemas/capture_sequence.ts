import { z } from 'zod';

/**
 * The multi-shot capture a body says a frame is one of: `rawler`'s `CaptureSequence`, through
 * `job::CaptureSequence`.
 *
 * `group` is a key every frame of one capture shares, which only pixel shift writes; `count` is
 * how many shots it fires, where the body says. `index` is 1-based, and null where the body does
 * not say which shot a frame was (Canon's focus bracketing).
 */
export const CaptureSequenceKindSchema = z.enum(['pixelShift', 'exposureBracket', 'focusBracket']);

export const CaptureSequenceSchema = z.object({
  kind: CaptureSequenceKindSchema,
  group: z.number().int().nullable(),
  index: z.number().int().positive().nullable(),
  count: z.number().int().positive().nullable(),
});
export type CaptureSequence = z.infer<typeof CaptureSequenceSchema>;
export type CaptureSequenceKind = z.infer<typeof CaptureSequenceKindSchema>;

export function sequenceColumn(sequence: CaptureSequence | null): string | null {
  return sequence == null ? null : JSON.stringify(sequence);
}

/** A stored `photos.capture_sequence`, or null for none or one this build cannot read. */
export function captureSequenceOf(stored: string | null): CaptureSequence | null {
  if (stored == null) return null;
  try {
    const parsed = CaptureSequenceSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
