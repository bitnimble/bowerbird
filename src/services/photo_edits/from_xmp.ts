import { neutralEdits, type EditDoc } from '../../schemas/photo_edits';
import type { XmpSettings } from '../processing/xmp_schema';

/**
 * What a sidecar produced, and everything about it we could not carry.
 *
 * `doc` is null where the file should not be applied at all, as opposed to applied
 * incompletely - the difference between "this is not an edit" and "this is an edit
 * with parts missing", which the caller has to be able to tell apart.
 */
export interface XmpImport {
  doc: EditDoc | null;
  /** Why the import was refused, or what it left behind. Caller-facing. */
  reasons: string[];
  /** `crs:` properties present in the file that no part of the model consumes. */
  unsupported: string[];
}

/**
 * Camera Raw's develop settings as edits of ours.
 *
 * This is a *pick*, not a conversion: `EditDoc` borrows Camera Raw's names and
 * `xmp.ts`'s ranges exactly - `crs:Exposure2012` is EV in -5..5, the tone and
 * presence sliders are -100..100, `crs:Temperature` is 2000..50000 - so there is
 * no constant here to get wrong. Choosing our own units is what would have put a
 * fudge factor on every line of this function, and is why we did not.
 *
 * Three refusals, each because the file is stating something we would otherwise
 * quietly get wrong:
 *
 * - **No develop settings.** A sidecar may hold only a rating and some keywords.
 * - **Already applied.** The pixels were rendered with these settings, so the
 *   values describe what is baked in rather than what to apply; applying them
 *   again double-processes the picture.
 * - **A pre-2012 process version.** `xmp_schema.ts` keeps `legacyTone` out of
 *   `tone` deliberately, because `Brightness` and `FillLight` have no current
 *   equivalent and back-filling would cost this layer the ability to tell a real
 *   value from an approximation. So this layer declines rather than guessing: an
 *   approximate import is worse than a refused one, because nothing downstream
 *   could tell it had happened.
 */
export function editsFromXmp(settings: XmpSettings): XmpImport {
  const reasons: string[] = [];
  const unsupported = [...settings.unsupported];

  if (settings.alreadyApplied) {
    return {
      doc: null,
      reasons: ['these settings are already baked into the pixels; applying them would double-process'],
      unsupported,
    };
  }
  const { tone, presence, whiteBalance } = settings;

  // The Kelvin pair travels together or not at all. Temperature without tint is
  // half a white balance, and the missing half reads as a colour cast - which is
  // also why "As Shot" is a null pair rather than a number this layer invents.
  const custom = whiteBalance.temperature != null && whiteBalance.tint != null;
  if (!custom && (whiteBalance.temperature != null || whiteBalance.tint != null)) {
    reasons.push('the white balance states only one of temperature and tint, so it was left as shot');
  }
  // The relative pair is the control for JPEG and TIFF sources. We only edit RAW,
  // so a file using it is describing a photo this import cannot be for.
  if (whiteBalance.incrementalTemperature !== 0 || whiteBalance.incrementalTint !== 0) {
    reasons.push('the white balance is the relative kind written for non-raw sources, and was not carried');
  }

  const doc: EditDoc = {
    ...neutralEdits(),
    exposure: tone.exposure,
    contrast: tone.contrast,
    highlights: tone.highlights,
    shadows: tone.shadows,
    whites: tone.whites,
    blacks: tone.blacks,
    texture: presence.texture,
    clarity: presence.clarity,
    dehaze: presence.dehaze,
    vibrance: presence.vibrance,
    saturation: presence.saturation,
    whiteBalanceMode: whiteBalance.mode,
    temperature: custom ? whiteBalance.temperature : null,
    tint: custom ? whiteBalance.tint : null,
  };

  // The parser already names every `crs:` property it does not itself consume, so
  // the curves, the HSL mixer, colour grading and the geometry controls arrive in
  // `unsupported` without help. What it cannot name is a block it *did* parse and
  // this layer has nowhere to put - the parametric curve is the one that bites,
  // because a frame graded entirely with it imports as neutral and would otherwise
  // look like an import that simply did nothing.
  const parametric =
    tone.parametricShadows !== 0 ||
    tone.parametricDarks !== 0 ||
    tone.parametricLights !== 0 ||
    tone.parametricHighlights !== 0;
  if (parametric) unsupported.push('the parametric curve');

  // Whether there is anything here, asked of the values rather than of
  // `crs:HasSettings`. That flag defaults to *false* when absent (`xmp.ts`), so
  // trusting it would refuse any sidecar not written by Camera Raw itself - a
  // hand-written or third-party one carrying real settings among them. A file
  // whose blocks are all at their defaults has nothing to import whatever it
  // claims; one that moved something has something, whatever it claims.
  const neutral = neutralEdits();
  const moved = Object.keys(neutral).some(
    (key) =>
      key !== 'version' &&
      (doc as Record<string, unknown>)[key] !== (neutral as Record<string, unknown>)[key],
  );
  // Ordered ahead of the process-version refusal on purpose. A sidecar holding a
  // rating and nothing else states no version either, so checking the era first
  // would tell a reader their keywords file "predates process version 2012" -
  // true, useless, and not why it was declined.
  if (!moved && !settings.hasSettings) {
    return { doc: null, reasons: ['this sidecar carries no develop settings'], unsupported };
  }

  // `xmp_schema.ts` keeps `legacyTone` out of `tone` deliberately, because
  // `Brightness` and `FillLight` have no 2012 equivalent and back-filling would
  // cost this layer the ability to tell a real value from an approximation. So it
  // declines rather than guessing: an approximate import is worse than a refused
  // one, because nothing downstream could tell it had happened.
  if (settings.legacy || settings.legacyTone != null) {
    const version = settings.processVersion.raw ?? 'an unstated version';
    return {
      doc: null,
      reasons: [`${version} predates process version 2012, whose controls these are; no mapping is calibrated`],
      unsupported,
    };
  }

  if (!settings.hasSettings) {
    reasons.push('the file does not flag itself as carrying develop settings, but states some');
  }

  return { doc, reasons, unsupported };
}
