import { z } from 'zod';

// The struct `parseXmp` produces: Camera Raw's develop settings as the file
// states them, not as Bowerbird models them. It is camelCase and lives here
// rather than in src/schemas/ because nothing serialises it over the wire; the
// mapping onto our own edit parameters is a separate piece of work, and keeping
// the two apart is what stops an external format dictating ours.
//
// Field names are the lowerCamelCase of each XMP tag's local name with every
// `2012`/`PV2012` deleted, so `crs:Exposure2012` is `tone.exposure`. The
// generation marker is the wire discriminator, not part of the meaning.

// The eight fixed HSL bands, in the order Camera Raw writes them.
export const BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
const BandsSchema = z.record(z.enum(BANDS), z.number());

const PointSchema = z.object({ x: z.number(), y: z.number() });
// A tone curve as points, never as the `"0, 0"` strings the file holds: the
// identity curve may be written out explicitly or omitted, and `"0,0"` is as
// legal as `"0, 0"`, so only a numeric comparison makes those the same thing.
const CurveSchema = z.array(PointSchema);

// ISO 8601 as written, split rather than parsed into a Date: XMP dates
// frequently carry no zone, and a zoneless date is local time in a zone the
// file does not name. Constructing a Date coerces it to UTC and loses that,
// which is why capture time is held the same way (§11.1).
export const XmpDateSchema = z.object({ value: z.string(), offset: z.string().nullable() });
export type XmpDate = z.infer<typeof XmpDateSchema>;

// A closed reason set because the consumer has to branch on it. `unconvertible`
// is for a value that is well-formed and simply cannot be used here: a crop in
// inches, an enum spelling we don't know.
export const IssueSchema = z.object({
  tag: z.string(),
  reason: z.enum(['clamped', 'unparseable', 'duplicate', 'malformed', 'unconvertible']),
  value: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;

// `crs:ProcessVersion` resolved, so no consumer re-parses it. A generation is
// only ever set for the current parameter set (process version 6.6 and later,
// where the `*2012` tags begin); null means the file predates it.
export const ProcessVersionSchema = z.union([
  z.object({ generation: z.number(), raw: z.string() }),
  z.object({ generation: z.null(), raw: z.string().nullable() }),
]);
export type ProcessVersion = z.infer<typeof ProcessVersionSchema>;

export const WhiteBalanceSchema = z.object({
  // `crs:WhiteBalance`, named against the rule above because the rule gives
  // `whiteBalance.whiteBalance` and the tag is the preset selector, not the
  // white balance itself. Open enum: `As Shot`, `Auto`, `Daylight`, `Cloudy`,
  // `Shade`, `Tungsten`, `Fluorescent`, `Flash`, `Custom`.
  mode: z.string(),
  // The only two parameters whose absence is null rather than a number. "As
  // shot" means the correct value is the camera's own recorded neutral, which
  // this layer cannot see; a fixed number here would white-balance every
  // as-shot import identically and wrongly.
  temperature: z.number().nullable(),
  tint: z.number().nullable(),
  // The white balance control for non-raw sources: a relative nudge, not a
  // Kelvin value, and not interchangeable with the pair above.
  incrementalTemperature: z.number(),
  incrementalTint: z.number(),
});

export const ToneSchema = z.object({
  // In EV, a linear stop multiplier. The rest of this block are unitless slider
  // positions whose mapping to any physical quantity is not in the file.
  exposure: z.number(),
  contrast: z.number(),
  highlights: z.number(),
  shadows: z.number(),
  whites: z.number(),
  blacks: z.number(),
  // Open: a user preset name is legal here alongside `Linear`,
  // `Medium Contrast`, `Strong Contrast` and `Custom`.
  curveName: z.string(),
  curve: CurveSchema,
  curveRed: CurveSchema,
  curveGreen: CurveSchema,
  curveBlue: CurveSchema,
  // The parametric curve, a second curve that composes with the point curve
  // above rather than replacing it. Both can be active at once.
  parametricShadows: z.number(),
  parametricDarks: z.number(),
  parametricLights: z.number(),
  parametricHighlights: z.number(),
  // The tone-range boundaries the four sliders above act within. Their defaults
  // are 25/50/75, not zero, so an omitted split means the default boundary and
  // not "no split".
  parametricShadowSplit: z.number(),
  parametricMidtoneSplit: z.number(),
  parametricHighlightSplit: z.number(),
});

export const PresenceSchema = z.object({
  texture: z.number(),
  clarity: z.number(),
  // A real, unlike its neighbours, and absent before process version 6.6.
  dehaze: z.number(),
  vibrance: z.number(),
  saturation: z.number(),
});

export const HslSchema = z.object({
  hue: BandsSchema,
  saturation: BandsSchema,
  luminance: BandsSchema,
  gray: BandsSchema,
  // Which of the two sets above is authoritative: the gray mixer when true, the
  // hue/saturation/luminance set when false. Both are commonly present in one
  // file, so presence decides nothing and both are carried - a user toggling the
  // conversion back expects their HSL values intact.
  convertToGrayscale: z.boolean(),
});

export const DetailSchema = z.object({
  sharpness: z.number(),
  sharpenRadius: z.number(),
  sharpenDetail: z.number(),
  sharpenEdgeMasking: z.number(),
  luminanceSmoothing: z.number(),
  luminanceNoiseReductionDetail: z.number(),
  luminanceNoiseReductionContrast: z.number(),
  // Defaults to 25, not 0. A file with no detail block at all still means 25
  // units of colour noise reduction, and rendering it as 0 gives visibly
  // speckled output with nothing anywhere reporting an error.
  colorNoiseReduction: z.number(),
  colorNoiseReductionDetail: z.number(),
  colorNoiseReductionSmoothness: z.number(),
});

// One block, not two: colour grading never got a full set of tags. It added the
// midtone and global controls and reused the split-toning tags for shadows and
// highlights, so there is no ColorGradeShadowHue, ColorGradeShadowSat,
// ColorGradeHighlightHue, ColorGradeHighlightSat or ColorGradeBalance to read.
// Reading only the `ColorGrade*` names would silently discard most of a grade.
export const ColorGradingSchema = z.object({
  splitToningShadowHue: z.number(),
  splitToningShadowSaturation: z.number(),
  splitToningHighlightHue: z.number(),
  splitToningHighlightSaturation: z.number(),
  splitToningBalance: z.number(),
  colorGradeShadowLuminance: z.number(),
  colorGradeMidtoneHue: z.number(),
  colorGradeMidtoneSaturation: z.number(),
  colorGradeMidtoneLuminance: z.number(),
  colorGradeHighlightLuminance: z.number(),
  colorGradeGlobalHue: z.number(),
  colorGradeGlobalSaturation: z.number(),
  colorGradeGlobalLuminance: z.number(),
  colorGradeBlending: z.number(),
});

export const LensSchema = z.object({
  lensProfileEnable: z.boolean(),
  // Open enum: `LensDefaults`, `Auto`, `Custom`.
  lensProfileSetup: z.string(),
  // Names a profile that lives outside the file. Recorded, never resolved here,
  // and an unresolvable one is not an import failure.
  lensProfileName: z.string().nullable(),
  lensProfileFilename: z.string().nullable(),
  lensProfileDigest: z.string().nullable(),
  lensProfileIsEmbedded: z.boolean(),
  lensProfileDistortionScale: z.number(),
  lensProfileChromaticAberrationScale: z.number(),
  lensProfileVignettingScale: z.number(),
  lensManualDistortionAmount: z.number(),
  autoLateralCA: z.boolean(),
  chromaticAberrationR: z.number(),
  chromaticAberrationB: z.number(),
  // The defringe amounts run 0..20, unlike almost everything else here.
  defringePurpleAmount: z.number(),
  defringePurpleHueLo: z.number(),
  defringePurpleHueHi: z.number(),
  defringeGreenAmount: z.number(),
  defringeGreenHueLo: z.number(),
  defringeGreenHueHi: z.number(),
});

export const EffectsSchema = z.object({
  // Manual lens vignetting, corrected against the sensor frame. Distinct from
  // the post-crop vignette below, which is applied relative to the cropped
  // frame; both can be non-zero.
  vignetteAmount: z.number(),
  vignetteMidpoint: z.number(),
  postCropVignetteAmount: z.number(),
  postCropVignetteMidpoint: z.number(),
  postCropVignetteFeather: z.number(),
  postCropVignetteRoundness: z.number(),
  // Selects the operator, not its intensity: 1 = Highlight Priority,
  // 2 = Color Priority, 3 = Paint Overlay, and the three behave differently
  // with respect to exposure.
  postCropVignetteStyle: z.number(),
  postCropVignetteHighlightContrast: z.number(),
  grainAmount: z.number(),
  grainSize: z.number(),
  grainFrequency: z.number(),
  grainSeed: z.number(),
});

// Applied before the colour matrix, on primaries rather than on rendered
// colour. Old presets lean on it heavily, so it matters most for exactly the
// legacy files that carry no current-generation tones.
export const CalibrationSchema = z.object({
  shadowTint: z.number(),
  redHue: z.number(),
  redSaturation: z.number(),
  greenHue: z.number(),
  greenSaturation: z.number(),
  blueHue: z.number(),
  blueSaturation: z.number(),
});

export const GeometrySchema = z.object({
  // Standard EXIF orientation codes, as the sidecar states them. It may
  // disagree with the raw's own orientation, and LibRaw's flip code is a
  // different encoding of the same idea; reconciling either is the consumer's.
  orientation: z.number().nullable(),
  // Authoritative. Crop values are frequently present and non-default while
  // this is false - stale state from a crop the user undid - so the edges are
  // only meaningful when this is true.
  hasCrop: z.boolean(),
  // Normalised fractions of the frame, not pixels, in the frame after
  // orientation is applied and rotated by `cropAngle`.
  cropTop: z.number(),
  cropLeft: z.number(),
  cropBottom: z.number(),
  cropRight: z.number(),
  cropAngle: z.number(),
  // Non-zero units (1 = inches, 2 = cm) break the fractions-only reading, and
  // converting needs frame dimensions this layer does not have. Carried
  // unmodified with an `unconvertible` issue instead.
  cropWidth: z.number().nullable(),
  cropHeight: z.number().nullable(),
  cropUnits: z.number(),
  cropConstrainToWarp: z.boolean(),
  perspectiveVertical: z.number(),
  perspectiveHorizontal: z.number(),
  // A separate rotation from `cropAngle` that composes with it; a file can
  // carry both.
  perspectiveRotate: z.number(),
  // 100, not 0: a missing value means unity scale, and treating it as 0
  // collapses the image.
  perspectiveScale: z.number(),
  perspectiveAspect: z.number(),
  perspectiveX: z.number(),
  perspectiveY: z.number(),
  // 0 = Off, 1 = Auto, 2 = Full, 3 = Level, 4 = Vertical, 5 = Guided. Carried
  // as its own value because non-zero means the geometry was determined by an
  // algorithm we cannot reproduce and the manual sliders do not describe the
  // result: "no automatic correction" and "a correction we did not reproduce"
  // must stay distinguishable, or the loss is unrecoverable downstream.
  perspectiveUpright: z.number(),
  uprightVersion: z.number().nullable(),
  uprightCenterMode: z.number().nullable(),
  uprightCenterNormX: z.number().nullable(),
  uprightCenterNormY: z.number().nullable(),
  uprightFocalMode: z.number().nullable(),
  uprightFocalLength35mm: z.number().nullable(),
  uprightTransformCount: z.number().nullable(),
  uprightFourSegmentsCount: z.number().nullable(),
});

// A reference, not a payload: the file names a profile that lives elsewhere and
// carries none of its data. The digest fingerprints that profile's contents, so
// a consumer can tell "same name, different profile" from a match.
export const CameraProfileSchema = z.object({
  cameraProfile: z.string().nullable(),
  cameraProfileDigest: z.string().nullable(),
});

// A creative rendering layered on top of the camera profile; the two compose.
// Null when the structure is absent, which is different from a Look whose
// fields are all defaults.
export const LookSchema = z.object({
  name: z.string().nullable(),
  amount: z.number().nullable(),
  uuid: z.string().nullable(),
  group: z.string().nullable(),
  cluster: z.string().nullable(),
  copyright: z.string().nullable(),
  supportsAmount: z.boolean().nullable(),
  supportsMonochrome: z.boolean().nullable(),
  supportsOutputReferred: z.boolean().nullable(),
});

export const MetadataSchema = z.object({
  // −1..5, where −1 means rejected rather than "one below zero". Real rather
  // than int because 3.5 is spec-legal, even though editors write integers.
  rating: z.number().nullable(),
  label: z.string().nullable(),
  createDate: XmpDateSchema.nullable(),
  modifyDate: XmpDateSchema.nullable(),
  metadataDate: XmpDateSchema.nullable(),
  // Both keyword tags: `subject` is flat and `hierarchicalSubject` carries the
  // tree, so reading only the first silently flattens a hierarchy the user built.
  subject: z.array(z.string()),
  hierarchicalSubject: z.array(z.string()),
  title: z.string().nullable(),
  description: z.string().nullable(),
  creator: z.array(z.string()),
  rights: z.string().nullable(),
  dateCreated: XmpDateSchema.nullable(),
  // What the sidecar says it belongs to. Recorded verbatim and never compared
  // here - this layer has no filename - but either disagreeing with the file
  // matched by base name means applying it would put someone else's edit on a
  // photo.
  sidecarForExtension: z.string().nullable(),
  rawFileName: z.string().nullable(),
});

// The pre-2012 tonal controls, read only from a pre-2012 file and never merged
// into `tone`: the controls were redesigned between generations, `Brightness`
// and `FillLight` have no current equivalent, and back-filling `tone` would
// cost the mapping layer the ability to tell a real value from an approximation.
// The nullable fields are the ones whose legacy default is unconfirmed, where a
// null is honest and a guessed non-zero number is not.
export const LegacyToneSchema = z.object({
  exposure: z.number(),
  brightness: z.number().nullable(),
  contrast: z.number().nullable(),
  shadows: z.number().nullable(),
  highlightRecovery: z.number(),
  fillLight: z.number(),
  clarity: z.number(),
  curve: CurveSchema,
  curveName: z.string().nullable(),
  curveRed: CurveSchema,
  curveGreen: CurveSchema,
  curveBlue: CurveSchema,
});

export const XmpSettingsSchema = z.object({
  processVersion: ProcessVersionSchema,
  // The Camera Raw build that wrote the file. It says which tags might be
  // present and never how to interpret them - feature availability tracks this,
  // parameter meaning tracks `processVersion` - and the one place it is
  // load-bearing is the sharpening default (§5.6).
  crsVersion: z.string().nullable(),
  legacy: z.boolean(),
  // Whether the file claims to carry develop settings at all; a sidecar may hold
  // only a rating and some keywords. Every block is populated with its defaults
  // either way, because making a dozen blocks nullable to encode one bit would
  // push the check into every consumer.
  hasSettings: z.boolean(),
  // The pixels have already been rendered with these settings. The values
  // describe what was baked in rather than what to apply, and applying them
  // again double-processes the image.
  alreadyApplied: z.boolean(),

  whiteBalance: WhiteBalanceSchema,
  tone: ToneSchema,
  presence: PresenceSchema,
  hsl: HslSchema,
  detail: DetailSchema,
  colorGrading: ColorGradingSchema,
  lens: LensSchema,
  effects: EffectsSchema,
  calibration: CalibrationSchema,
  geometry: GeometrySchema,
  profile: CameraProfileSchema,
  look: LookSchema.nullable(),
  metadata: MetadataSchema,

  legacyTone: LegacyToneSchema.nullable(),
  // The names, never the values, of every `crs:` property present that this
  // parser does not consume: masks, retouching, HDR, the opaque upright
  // payloads. Sorted and deduplicated. They let a caller disclose that an edit
  // was imported incompletely, and aggregated across a library they say which
  // tag is worth supporting next. The values would buy only a re-parse we can
  // do anyway, since the sidecar stays on disk.
  unsupported: z.array(z.string()),
  issues: z.array(IssueSchema),
});
export type XmpSettings = z.infer<typeof XmpSettingsSchema>;
