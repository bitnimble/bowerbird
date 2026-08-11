import { neutralEdits, sameEditValue, type EditDoc } from '../../schemas/photo_edits';
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
/**
 * Whether a pre-2012 file's tone controls hold anything, which is what makes its era
 * matter.
 *
 * The scalars first, then the curves. A curve is the one that would otherwise slip
 * through: `crs:ToneCurveName` reads "Linear" or is absent on a file nobody curved, but
 * a *custom* curve leaves the name behind while the points carry the edit - so the
 * points are checked rather than the name, and a straight line through the corners is
 * what "untouched" looks like whatever it is called.
 */
function legacyToneMoved(legacy: XmpSettings['legacyTone']): boolean {
  if (legacy == null) return false;
  const scalars = [
    legacy.exposure,
    legacy.brightness,
    legacy.contrast,
    legacy.shadows,
    legacy.highlightRecovery,
    legacy.fillLight,
    legacy.clarity,
  ];
  if (scalars.some((value) => value != null && value !== 0)) return true;
  const bent = (curve: { x: number; y: number }[]): boolean =>
    curve.length !== 2 || curve.some((point) => point.x !== point.y);
  return [legacy.curve, legacy.curveRed, legacy.curveGreen, legacy.curveBlue].some(bent);
}

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

  // `hasCrop` is authoritative and the edges are stale without it: a crop the reader undid
  // routinely leaves non-default values behind, so a file that says it is not cropped is
  // not cropped whatever its edges read. The straighten goes with them - it is the same
  // undone edit, and carrying it alone would rotate a frame we are not cropping.
  const geometry = settings.geometry;
  const crop = geometry.hasCrop
    ? {
        cropLeft: geometry.cropLeft,
        cropTop: geometry.cropTop,
        cropRight: geometry.cropRight,
        cropBottom: geometry.cropBottom,
        cropAngle: geometry.cropAngle,
      }
    : {};
  // Absolute units mean the fractions are not the whole story and converting needs the
  // frame's dimensions, which the parser says it does not have either.
  if (geometry.hasCrop && geometry.cropUnits !== 0) {
    reasons.push('the crop is stated in absolute units, which this import cannot convert, so it was left uncropped');
  }
  // Still unsupported with a perspective tool in the editor, and not an oversight. The sidecar
  // states its correction as slider positions on a parameterisation of its own; this document
  // holds the homography a pair of guides produced. There is no conversion without knowing what
  // those sliders mean in degrees, and a number carried across on the strength of sharing a name
  // is a photograph bent by an amount nobody asked for.
  if (geometry.perspectiveVertical !== 0 || geometry.perspectiveHorizontal !== 0 || geometry.perspectiveRotate !== 0) {
    unsupported.push('the perspective corrections');
  }

  const doc: EditDoc = {
    ...neutralEdits(),
    ...(geometry.hasCrop && geometry.cropUnits === 0 ? crop : {}),
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
      !sameEditValue((doc as Record<string, unknown>)[key], (neutral as Record<string, unknown>)[key]),
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
  //
  // **Only where there is something to guess at.** An old sidecar whose tone
  // controls are all where Camera Raw left them has nothing this layer would have
  // to approximate, and refusing it throws away the parts that never had an era:
  // a crop is the same fractions in 2010 and now, and Kelvin is Kelvin. Measured
  // over a library of 470 real sidecars, every legacy file in it was exactly that
  // - a crop and nothing else - so the blanket refusal cost eleven importable
  // crops and explained itself by naming a process version the reader never chose.
  if (settings.legacy || settings.legacyTone != null) {
    const version = settings.processVersion.raw ?? 'an unstated version';
    if (legacyToneMoved(settings.legacyTone)) {
      return {
        doc: null,
        reasons: [`${version} predates process version 2012, whose controls these are; no mapping is calibrated`],
        unsupported,
      };
    }
    reasons.push(
      `${version} predates process version 2012, but its tone controls are untouched, ` +
        'so only the parts that do not depend on an era were taken',
    );
  }

  if (!settings.hasSettings) {
    reasons.push('the file does not flag itself as carrying develop settings, but states some');
  }

  return { doc, reasons, unsupported };
}
