import { adjustOf } from '../../../schemas/edit_adjust';
import { dustSettings } from '../../../schemas/dust_settings';
import { EditDocSchema, type EditDoc } from '../../../schemas/photo_edits';
import type { PrepareDevelop } from '../../../schemas/prepare_develop';
import type { Developed } from '../workers/processing_types';

/**
 * No exposure, no adjustment, whole frame: the picture as the camera made it.
 *
 * The empty document through the same mapping every stored one takes, so a default that moves in
 * `EditDocSchema` moves here too. "As metered" is about the *grade*: a photo nobody has edited is
 * still denoised and still sharpened, at whatever the sliders open at.
 */
export const AS_METERED = {
  ...asJob(EditDocSchema.parse({})),
  // Off, against the document's own default: finding the particles costs a whole-frame read, and a
  // photo nobody has edited has not asked for one.
  dust: dustSettings(undefined),
};

/**
 * The stored develop settings as the job wants them.
 *
 * **Every field passes through unchanged, and that is the point.** `EditDoc` holds Camera Raw's
 * own scales and the shaders are written against them, so there is no constant here to get
 * wrong - not even the exposure, which stays stops rather than becoming a `2^EV` gain on the way
 * past. Converting it here means converting it again in the editor, which is one rule with an
 * implementation on each path; `colour.slang` raises the stops once, for both.
 *
 * An unedited photo has no row, which is the common case and reads as no adjustment. A
 * document this build cannot parse reads the same way rather than failing the batch: a
 * rendition of the picture as the camera metered it is a worse rendition than the reader
 * asked for and a far better outcome than a photo that never builds one.
 */
export function developed(edits: string | null, previewing?: PrepareDevelop): FromDocument {
  if (edits == null && previewing == null) return AS_METERED;
  try {
    const stored: unknown = edits == null ? {} : JSON.parse(edits);
    const parsed = EditDocSchema.safeParse(
      previewing == null ? stored : { ...(stored as object), ...previewing },
    );
    if (!parsed.success) return AS_METERED;
    return asJob(parsed.data);
  } catch {
    return AS_METERED;
  }
}

/** Everything a job's develop settings hold except the defringe, which is the library's. */
type FromDocument = Omit<Developed, 'defringe'>;

function asJob(doc: EditDoc): FromDocument {
  return {
    exposure: doc.exposure,
    denoiseLuminance: doc.luminanceNoise,
    denoiseColour: doc.colourNoise,
    denoiser: doc.denoiser,
    // A position on a 0..100 track on this side and a fraction of the deconvolution on the
    // other; the shader's own gain is what the top of that track is worth.
    sharpen: doc.sharpening / 100,
    // The one field here that is not passed through unchanged, and the editor's open calls the
    // same function for the same reason.
    dust: dustSettings(doc),
    repairs: doc.repairs,
    adjust: adjustOf(doc),
    geometry: {
      crop: [doc.cropLeft, doc.cropTop, doc.cropRight, doc.cropBottom],
      angleDegrees: doc.cropAngle,
      rotate: doc.rotate,
      keystone: doc.keystone,
    },
  };
}
