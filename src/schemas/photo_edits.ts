import { z } from 'zod';

// One photo's develop settings: what the editor shows, what a rendition is built
// from, and what an undo steps through.
//
// **Flat, and named as Camera Raw names things.** Both choices are load-bearing.
// Flat because a delta is a `Partial<EditDoc>` (§5 of the design doc) and a nested
// shape would make a partial of one field mean the whole block. Camera Raw's names
// and Camera Raw's ranges because importing a Lightroom sidecar is a stated
// requirement, and `xmp_schema.ts` already models the file's own vocabulary - so
// `fromXmp` below is a pick rather than a table of conversions. Choosing our own
// units would have put a fudge factor on every line of it.
//
// Ranges are `xmp.ts`'s, exactly: `crs:Exposure2012` is -5..5 real, the rest of
// the tone and presence sliders are -100..100, `crs:Temperature` is 2000..50000
// and `crs:Tint` is -150..150.

// The Kelvin pair is null when the white balance is the camera's own, which is
// what "As Shot" means and what no number can say. `xmp_schema.ts` states the
// reason: a fixed value here would white-balance every as-shot import identically
// and wrongly, because the correct answer is the neutral the body recorded and
// this layer cannot see it.
//
// Both move together or neither does. Temperature without tint is not a white
// balance, it is half of one, and the half that is missing reads as a colour cast.
export const WhiteBalanceModeSchema = z.string().default('As Shot');

export const EditDocSchema = z
  .object({
    // A number with a default, not `z.literal(1)`. A literal rejects a document
    // written by a newer build *before* anything can read its version and pick a
    // migration, which is the whole of what migrating on read needs. Defaults only
    // rescue a missing field, i.e. the case where the version would not have moved.
    version: z.number().int().default(1),

    // Tone. `exposure` is EV and is the only one here with a physical unit; the
    // rest are slider positions whose mapping to anything is ours to decide.
    exposure: z.number().min(-5).max(5).default(0),
    contrast: z.number().int().min(-100).max(100).default(0),
    highlights: z.number().int().min(-100).max(100).default(0),
    shadows: z.number().int().min(-100).max(100).default(0),
    whites: z.number().int().min(-100).max(100).default(0),
    blacks: z.number().int().min(-100).max(100).default(0),

    // Presence. `dehaze` is a real where its neighbours are integers, which is
    // Camera Raw's own inconsistency and not worth correcting away from.
    texture: z.number().int().min(-100).max(100).default(0),
    clarity: z.number().int().min(-100).max(100).default(0),
    dehaze: z.number().min(-100).max(100).default(0),
    vibrance: z.number().int().min(-100).max(100).default(0),
    // Named as Camera Raw names it. The `Edit` uniform already has a `saturation`
    // that is the camera match's own fit multiplier around 1.0 and not a slider
    // (`colour.wgsl`), so the shader has to give this one a distinct uniform name -
    // renaming it *here* would cost the import its identity mapping instead.
    saturation: z.number().int().min(-100).max(100).default(0),

    // Detail. Both are positions on a slider rather than a strength in anything: the
    // rendition's denoise reads them as GALOSH's own two knobs (`galosh::Amounts`) and the
    // editor's reads them as its cheaper sRGB-domain twin, so a single physical unit here
    // would be a unit belonging to one of the two.
    //
    // **The scale's landmark is its middle, not its end.** The shrinkage normalises the
    // plane to the noise it measured, so 50 is the calibrated point - exactly that much
    // treated as noise - and the top half is headroom for the measurement being wrong, since
    // a frame whose quietest blocks still hold texture reads low and would otherwise be
    // stuck under-denoised.
    //
    // **They default to 40**, four fifths of the calibrated amount: short of it, because the
    // failure on that side is grain and on the other side is smearing, and grain is the one
    // that still reads as a photograph. Grain in luma is worth keeping some of where colour
    // mottle has no such defence, which is why the two are separate at all.
    luminanceNoise: z.number().int().min(0).max(100).default(20),
    colourNoise: z.number().int().min(0).max(100).default(30),

    // White balance. The mode is an open enum in the file - `As Shot`, `Auto`,
    // `Daylight`, `Custom` and a user preset name are all legal - so it is a string.
    whiteBalanceMode: WhiteBalanceModeSchema,
    temperature: z.number().int().min(2000).max(50000).nullable().default(null),
    tint: z.number().int().min(-150).max(150).nullable().default(null),

    // Geometry. Fractions of the frame rather than pixels, because one document grades an
    // 800px tile, a 3840px `full` and a native-resolution `max`, and a pixel rectangle
    // would be right for exactly one of them.
    //
    // **The frame they are fractions of is the one after the photo's own orientation and
    // after `cropAngle`**, which is Camera Raw's definition (`xmp_schema.ts` states it) and
    // so the one an import maps onto without a conversion. Getting this wrong is not
    // visible in a square test image, which is why it is written down rather than implied.
    //
    // No `hasCrop` flag. The sidecar needs one because a crop the user undid leaves stale
    // edges behind, but this document is ours and the full-frame rect *is* no crop - a flag
    // beside it would be a second answer to the same question, free to disagree.
    cropLeft: z.number().min(0).max(1).default(0),
    cropTop: z.number().min(0).max(1).default(0),
    cropRight: z.number().min(0).max(1).default(1),
    cropBottom: z.number().min(0).max(1).default(1),

    // The rectangle the reader framed, which the four above are fitted out of when "crop to
    // fit" trims the wedges a straighten leaves.
    //
    // **Not a second answer to the same question**, which is what the missing `hasCrop` flag
    // above would have been. This is the fit's *input* and those are its output, and the fit
    // is lossy - a rectangle pulled in off a 40-degree straighten cannot say what it was
    // before - so without these the reader's framing is gone the moment it is applied, and
    // walking the slider back gives them the trimmed rectangle rather than the one they chose.
    //
    // Null where nothing has been fitted yet, which reads as the crop above: an imported
    // sidecar arrives cropped and that rectangle is the reader's, not a fit of anything. Only
    // the editor writes these; every renderer reads the crop.
    framedLeft: z.number().min(0).max(1).nullable().default(null),
    framedTop: z.number().min(0).max(1).nullable().default(null),
    framedRight: z.number().min(0).max(1).nullable().default(null),
    framedBottom: z.number().min(0).max(1).nullable().default(null),
    /** Straighten, in degrees. Camera Raw's range, and its sign. */
    cropAngle: z.number().min(-45).max(45).default(0),
    /**
     * Quarter turns clockwise, on top of the photo's own EXIF orientation.
     *
     * On top of rather than replacing it: `photos.orientation` is what the camera recorded
     * and is already applied to the pixels the editor opens, so a document that restated it
     * would be a second copy of the same fact - and the two would disagree the first time a
     * re-read of the header corrected one of them.
     */
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),

    /**
     * The perspective correction, row-major, the ninth element dropped because it is always 1.
     *
     * **Corrected back to source, in fractions of the frame**, which is the direction every
     * gather here reads and the units that let one document drive a tile and a native-resolution
     * rendition. Applied to the frame *before* the straighten and the crop: it is a correction
     * of the camera's angle to the subject, so it belongs where the lens correction is, under
     * everything the reader chose afterwards.
     *
     * Null, not the identity. A photo nobody has corrected holds no matrix at all, so a later
     * change of convention cannot reinterpret one that was never meant.
     *
     * **The matrix is stored, not derived on read.** Deriving it needs the guides below and a
     * page of projective geometry, and a renderer that re-derived would be a second answer free
     * to disagree with the one the reader accepted - across two languages, at that. So the tool
     * computes it once and the document carries the result.
     */
    keystone: z
      .tuple([
        z.number(),
        z.number(),
        z.number(),
        z.number(),
        z.number(),
        z.number(),
        z.number(),
        z.number(),
      ])
      .nullable()
      .default(null),

    /**
     * The lines the reader drew, kept so the tool can be reopened on them.
     *
     * Not what renders - `keystone` is - and deliberately: these are the *description* of the
     * correction, in the reader's terms, and a photo can carry a correction with no guides at
     * all if it arrived from somewhere else.
     */
    keystoneGuides: z
      .array(
        z.object({
          x1: z.number(),
          y1: z.number(),
          x2: z.number(),
          y2: z.number(),
        }),
      )
      .max(4)
      .default([]),
  })
  // Unknown keys are kept, not stripped. A document written by a newer build and
  // round-tripped through an older one would otherwise come back with its new
  // parameters silently deleted - data loss with nothing raised, on the one path
  // (open an older client against a newer catalogue) most likely to hit it.
  .loose();

export type EditDoc = z.infer<typeof EditDocSchema>;

/** The document an unedited photo has. Every field at the value that changes nothing. */
export function neutralEdits(): EditDoc {
  return EditDocSchema.parse({});
}

// `displaySize` was here and is now `display_size.ts`, which imports `EditDoc` as a type and
// nothing else. The page needs the function - the editor's stage is laid out on it - and this
// module imports zod, which the page deliberately keeps out of its bundle.

// The fields a delta names, on each side of it. A commit routinely moves several
// at once - an import writes ten, a crop drag four - and a delta that could hold
// only one would turn each of those into several undos through states the picture
// was never in.
//
// **The sides are opaque records, not `EditDocSchema.partial()`.** `.partial()`
// makes a field optional and does *not* remove its `.default()`, so a schema whose
// every field has one refills each absent key on the way back in: a delta written
// as `{contrast: 0}` reads as a whole neutral document, and undoing it resets every
// field the edit never touched. A test caught it; the values here are server-derived
// from an already-validated document, so re-checking their ranges bought nothing
// and cost that.
export const EditDeltaSchema = z.object({
  from: z.record(z.string(), z.unknown()),
  to: z.record(z.string(), z.unknown()),
});
export type EditDelta = z.infer<typeof EditDeltaSchema>;

// The undo stack as it is stored: one row per photo holding the whole array
// (§2). Parsed defensively - nothing renders a picture from this, so a corrupt
// history degrades to "no undo available" rather than failing the editor's open.
export const EditHistorySchema = z.array(EditDeltaSchema);
export type EditHistory = z.infer<typeof EditHistorySchema>;

/** What every edits endpoint answers with. `rev` is required on the next write. */
export const EditStateSchema = z.object({
  doc: EditDocSchema,
  rev: z.number().int().min(0),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
});
export type EditState = z.infer<typeof EditStateSchema>;

export const SaveEditsRequestSchema = z.object({
  doc: EditDocSchema,
  // The revision the client read. A mismatch is a 409 rather than a silent
  // overwrite: without it two tabs do not merely lose an edit, the server's diff
  // invents a delta for a change nobody made and undo walks back through it.
  rev: z.number().int().min(0),
});
export type SaveEditsRequest = z.infer<typeof SaveEditsRequestSchema>;

export const StepEditsRequestSchema = z.object({ rev: z.number().int().min(0) });
export type StepEditsRequest = z.infer<typeof StepEditsRequestSchema>;

/**
 * Whether one field of a document still holds what it held.
 *
 * `===` is what this was, and it is wrong for the keystone: an array is compared by identity, so
 * a document that had been re-parsed - which every read does - held a *different* empty array
 * from the one it was compared against, and every retried save appended a delta for a change
 * nobody made. Exported because two callers ask this question, and one of them asking it the
 * old way is a sidecar of nothing that reads as a sidecar of something.
 *
 * Structural, and only as deep as the document goes: numbers, and records of numbers.
 */
export function sameEditValue(was: unknown, now: unknown): boolean {
  if (was === now) return true;
  // Before the object arm below, which would otherwise call `[]` and `{}` the same thing: an
  // array's keys are its indices, so a list and a record of the same numbers compare equal.
  if (Array.isArray(was) !== Array.isArray(now)) return false;
  if (Array.isArray(was) && Array.isArray(now)) {
    return was.length === now.length && was.every((element, index) => sameEditValue(element, now[index]));
  }
  if (was == null || now == null || typeof was !== 'object' || typeof now !== 'object') return false;
  const keys = Object.keys(was);
  return (
    keys.length === Object.keys(now).length &&
    keys.every((key) =>
      sameEditValue((was as Record<string, unknown>)[key], (now as Record<string, unknown>)[key]),
    )
  );
}

/**
 * Every field where `to` differs from `from`, on both sides.
 *
 * Returns null when nothing moved, which is what keeps a retried save from
 * appending a delta that undoes to the same picture it redoes to.
 *
 * **Over the keys the documents actually hold, not only the ones this build knows.** The schema
 * is `.loose()` precisely so a newer client's parameter survives a round trip through an older
 * server - and a diff blind to it made that survival worse than useless: a save that moved only
 * such a field wrote nothing and answered 200, so the client marked itself clean and the edit
 * was gone; a save that moved one alongside a known field stored it but left it out of the
 * delta, so undo produced a document that never existed.
 */
export function diffEdits(from: EditDoc, to: EditDoc): EditDelta | null {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  let moved = false;
  const named = new Set([...Object.keys(EditDocSchema.shape), ...Object.keys(from), ...Object.keys(to)]);
  for (const key of named) {
    if (key === 'version') continue;
    const was = (from as Record<string, unknown>)[key];
    const now = (to as Record<string, unknown>)[key];
    if (sameEditValue(was, now)) continue;
    before[key] = was;
    after[key] = now;
    moved = true;
  }
  return moved ? { from: before, to: after } : null;
}

/**
 * One side of a delta laid over a document, which is what undo and redo both do.
 *
 * Re-parsed rather than merged and stored, because the patch's values are opaque
 * (see `EditDeltaSchema`) and a history that has been tampered with or written by
 * a build that meant something different must not put an out-of-range value into
 * the document a render then reads. A patch that will not parse leaves the
 * document where it was, which costs that one step and nothing else.
 */
export function applyEdits(doc: EditDoc, patch: Record<string, unknown>): EditDoc {
  const parsed = EditDocSchema.safeParse({ ...doc, ...patch });
  return parsed.success ? parsed.data : doc;
}
