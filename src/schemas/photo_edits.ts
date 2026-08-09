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
    // Named as Camera Raw names it. The tick's uniform already has a `saturation`
    // that is the camera match's own fit multiplier around 1.0 and not a slider
    // (`colour.wgsl`), so the shader has to give this one a distinct uniform name -
    // renaming it *here* would cost the import its identity mapping instead.
    saturation: z.number().int().min(-100).max(100).default(0),

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

/**
 * What a photo *looks* like once its geometry is applied, given the file's own dimensions.
 *
 * The grid lays out on this rather than on `photos.width`/`height`, which stay the file's:
 * a cropped photo occupies a different shape on the wall, and a tile laid out at the file's
 * aspect would be letterboxed or stretched for the life of the library.
 *
 * Three steps, in the order the fractions are defined against (`EditDocSchema`):
 *
 *  1. the straighten, which grows the frame to the bounding box of the rotated rectangle -
 *     this is why a 1-degree straighten on a wide frame is not a no-op even uncropped;
 *  2. the crop, as fractions of *that*;
 *  3. the quarter turn, which swaps the pair.
 *
 * Rounded, and floored at one: a rendition of zero pixels is not a picture, and the crop
 * fractions are free to describe a rectangle narrower than a pixel at tile size.
 */
export function displaySize(width: number, height: number, doc: EditDoc): { width: number; height: number } {
  const radians = (Math.abs(doc.cropAngle) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const straightened = {
    width: width * cos + height * sin,
    height: width * sin + height * cos,
  };

  const cropped = {
    width: straightened.width * Math.max(doc.cropRight - doc.cropLeft, 0),
    height: straightened.height * Math.max(doc.cropBottom - doc.cropTop, 0),
  };

  const turned = doc.rotate === 90 || doc.rotate === 270;
  return {
    width: Math.max(1, Math.round(turned ? cropped.height : cropped.width)),
    height: Math.max(1, Math.round(turned ? cropped.width : cropped.height)),
  };
}

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
 * Every field where `to` differs from `from`, on both sides.
 *
 * Returns null when nothing moved, which is what keeps a retried save from
 * appending a delta that undoes to the same picture it redoes to.
 */
export function diffEdits(from: EditDoc, to: EditDoc): EditDelta | null {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  let moved = false;
  for (const key of Object.keys(EditDocSchema.shape)) {
    if (key === 'version') continue;
    const was = (from as Record<string, unknown>)[key];
    const now = (to as Record<string, unknown>)[key];
    if (was === now) continue;
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
