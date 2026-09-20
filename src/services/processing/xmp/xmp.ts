import { BANDS, XmpSettingsSchema, type Issue, type XmpSettings } from './xmp_schema';
import { parseXmpProperties, Properties } from './xmp_document';

// Camera Raw's develop settings, read out of an XMP packet: a sidecar next to a
// raw, or the packet embedded in a DNG or a JPEG. All three carry the same
// document, which is why this takes a string rather than a path.
//
// It never throws and returns null only for input that is not XMP at all: this
// sits on the library scan, where one unreadable file must not fail the scan,
// the same reason exif_zone.ts returns null.

// Shipped as tabulated but never confirmed against a corpus of real sidecars,
// and still to be: the temperature and tint ranges, the luminance noise
// reduction detail default, every defringe hue bound, both vignette midpoints,
// the grain size, frequency and seed, the crop angle range, the crop unit
// codes, the perspective rotate range, and the Look field list, which is
// unlikely to be exhaustive. A wrong one here is a plausible value applied
// silently, so each is worth re-checking before anything leans on it.
//
// Not answerable here at all: which frame §6.2's crop coordinates sit in, and
// the sign and centre of the straighten rotation. Confirming those means
// applying the transform and looking at the result, so it is carried forward to
// whatever renders the geometry rather than treated as settled.

const ANY = Number.POSITIVE_INFINITY;
const WHITE_BALANCES = ['As Shot', 'Auto', 'Daylight', 'Cloudy', 'Shade', 'Tungsten', 'Fluorescent', 'Flash', 'Custom'];
const TONE_CURVE_NAMES = ['Linear', 'Medium Contrast', 'Strong Contrast', 'Custom'];
const LENS_PROFILE_SETUPS = ['LensDefaults', 'Auto', 'Custom'];

// Dotted numeric versions compare componentwise, never as strings: "15.4" is
// above "6.6" and a string compare gets that backwards. Two or more components,
// so "11" and "6.7.0.0" both parse.
const VERSION = /^\d+(\.\d+)*$/;

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function atLeast(version: string | null, floor: string): boolean {
  const value = version?.trim() ?? '';
  return VERSION.test(value) && compareVersions(value, floor) >= 0;
}

// The `*2012` parameter set begins at process version 6.6, not at 11.0: every
// file written between 2012 and the generation-5 switch carries 6.6 or 6.7
// alongside a full set of `*2012` tags, and a gate at 11.0 would classify all of
// them as legacy and discard their tones. Later generations refine the rendering
// without renaming parameters, which is why one threshold covers them all.
function generationOf(raw: string | null): number | null {
  if (!atLeast(raw, '6.6')) return null;
  const version = raw!.trim();
  if (compareVersions(version, '15.4') >= 0) return 6;
  if (compareVersions(version, '11.0') >= 0) return 5;
  if (compareVersions(version, '10.0') >= 0) return 4;
  return 3;
}

function bands(read: (band: string) => number): Record<(typeof BANDS)[number], number> {
  const out = {} as Record<(typeof BANDS)[number], number>;
  for (const band of BANDS) out[band] = read(band[0]!.toUpperCase() + band.slice(1));
  return out;
}

/**
 * @param xml an XMP packet: a sidecar's contents, or the packet lifted out of a
 * raw or a rendered file. Leading BOM and xpacket padding are tolerated.
 * @returns null when the input is not well-formed XML or carries no `rdf:RDF`.
 * Anything below that degrades: values clamp, unparseable ones fall back to
 * their defaults, and both are reported in `issues`.
 */
export function parseXmp(xml: string): XmpSettings | null {
  const parsed = parseXmpProperties(xml);
  if (parsed == null) return null;
  try {
    return read(parsed.properties, parsed.issues);
  } catch {
    return null;
  }
}

function read(p: Properties, issues: Issue[]): XmpSettings {
  const processVersion = p.text('crs:ProcessVersion');
  const generation = generationOf(processVersion);
  const legacy = generation == null;
  const crsVersion = p.text('crs:Version');

  // A version that is present but not a dotted number is reported rather than
  // read as absent. This is the most consequential unparseable value in the
  // format - it diverts the whole current-generation parameter set - so it is
  // the last one that should degrade in silence.
  for (const [tag, value] of [['crs:ProcessVersion', processVersion], ['crs:Version', crsVersion]] as const) {
    if (value != null && !VERSION.test(value.trim())) p.record(tag, 'unparseable', value);
  }

  // On a legacy file the current-generation tags are read from an empty set, so
  // every one of them lands on its documented default rather than on a value
  // that meant something else two generations ago. Any that are present stay
  // unconsumed and are reported in `unsupported`, and vice versa for the legacy
  // tags on a current file.
  const current = legacy ? new Properties(issues) : p;

  // The one place the writer build decides how to read a value: the sharpening
  // default was raised from 25 to 40 at Camera Raw 10.3, and it is a visible
  // difference rather than a rounding one.
  const sharpnessDefault = atLeast(crsVersion, '10.3') ? 40 : 25;

  const hasCrop = p.flag('crs:HasCrop', false);
  const cropTop = p.real('crs:CropTop', 0, 1, 0);
  const cropLeft = p.real('crs:CropLeft', 0, 1, 0);
  const cropBottom = p.real('crs:CropBottom', 0, 1, 1);
  const cropRight = p.real('crs:CropRight', 0, 1, 1);
  const cropAngle = p.real('crs:CropAngle', -45, 45, 0);
  const degenerate = cropTop >= cropBottom || cropLeft >= cropRight;
  if (hasCrop && degenerate) {
    // Whichever edge of the inverted pair the file actually wrote: the other one
    // is sitting on its default, and naming a tag that is not in the file with
    // an empty value says nothing a consumer can act on.
    const pair = cropTop >= cropBottom ? ['crs:CropTop', 'crs:CropBottom'] : ['crs:CropLeft', 'crs:CropRight'];
    const tag = pair.find((edge) => p.verbatim(edge) !== '') ?? pair[1]!;
    p.record(tag, 'malformed', p.verbatim(tag));
  }
  // `crs:HasCrop` is authoritative: stale edges from a crop the user undid are
  // routinely left behind non-default, so with no crop the edges read as the
  // whole frame rather than as whatever the file still holds. The straighten
  // angle goes with them - it is the same undone edit, and it is its own step of
  // the geometry, so a consumer keying off it would rotate a frame it is not
  // cropping.
  const cropped = hasCrop && !degenerate;
  const cropUnits = p.enumInt('crs:CropUnits', [0, 1, 2], 0);
  // Absolute units mean the fractions are not the whole story, and converting
  // needs frame dimensions this layer does not have.
  if (cropUnits !== 0) p.record('crs:CropUnits', 'unconvertible', p.verbatim('crs:CropUnits'));

  const lookFields = p.struct('crs:Look');

  const settings = {
    processVersion: generation == null
      ? { generation: null, raw: processVersion }
      : { generation, raw: processVersion! },
    crsVersion,
    legacy,
    hasSettings: p.flag('crs:HasSettings', false),
    alreadyApplied: p.flag('crs:AlreadyApplied', false),

    whiteBalance: {
      mode: p.enumeration('crs:WhiteBalance', WHITE_BALANCES, 'As Shot'),
      // Kept whatever the mode says, and null only on genuine absence: a named
      // preset with the pair omitted is not an error, and null is what tells the
      // mapping layer to resolve against the camera's own neutral.
      temperature: p.intOrNull('crs:Temperature', 2000, 50000),
      tint: p.intOrNull('crs:Tint', -150, 150),
      incrementalTemperature: p.int('crs:IncrementalTemperature', -100, 100, 0),
      incrementalTint: p.int('crs:IncrementalTint', -100, 100, 0),
    },

    tone: {
      exposure: current.real('crs:Exposure2012', -5, 5, 0),
      contrast: current.int('crs:Contrast2012', -100, 100, 0),
      highlights: current.int('crs:Highlights2012', -100, 100, 0),
      shadows: current.int('crs:Shadows2012', -100, 100, 0),
      whites: current.int('crs:Whites2012', -100, 100, 0),
      blacks: current.int('crs:Blacks2012', -100, 100, 0),
      curveName: current.enumeration('crs:ToneCurveName2012', TONE_CURVE_NAMES, 'Linear'),
      curve: current.curve('crs:ToneCurvePV2012'),
      curveRed: current.curve('crs:ToneCurvePV2012Red'),
      curveGreen: current.curve('crs:ToneCurvePV2012Green'),
      curveBlue: current.curve('crs:ToneCurvePV2012Blue'),
      parametricShadows: p.int('crs:ParametricShadows', -100, 100, 0),
      parametricDarks: p.int('crs:ParametricDarks', -100, 100, 0),
      parametricLights: p.int('crs:ParametricLights', -100, 100, 0),
      parametricHighlights: p.int('crs:ParametricHighlights', -100, 100, 0),
      parametricShadowSplit: p.int('crs:ParametricShadowSplit', 0, 100, 25),
      parametricMidtoneSplit: p.int('crs:ParametricMidtoneSplit', 0, 100, 50),
      parametricHighlightSplit: p.int('crs:ParametricHighlightSplit', 0, 100, 75),
    },

    presence: {
      texture: p.int('crs:Texture', -100, 100, 0),
      clarity: current.int('crs:Clarity2012', -100, 100, 0),
      // Did not exist before the current generation, so it is not read off a
      // legacy file even if something wrote one there.
      dehaze: current.real('crs:Dehaze', -100, 100, 0),
      vibrance: p.int('crs:Vibrance', -100, 100, 0),
      saturation: p.int('crs:Saturation', -100, 100, 0),
    },

    hsl: {
      hue: bands((band) => p.int(`crs:HueAdjustment${band}`, -100, 100, 0)),
      saturation: bands((band) => p.int(`crs:SaturationAdjustment${band}`, -100, 100, 0)),
      luminance: bands((band) => p.int(`crs:LuminanceAdjustment${band}`, -100, 100, 0)),
      gray: bands((band) => p.int(`crs:GrayMixer${band}`, -100, 100, 0)),
      convertToGrayscale: p.flag('crs:ConvertToGrayscale', false),
    },

    detail: {
      sharpness: p.int('crs:Sharpness', 0, 150, sharpnessDefault),
      sharpenRadius: p.real('crs:SharpenRadius', 0.5, 3, 1),
      sharpenDetail: p.int('crs:SharpenDetail', 0, 100, 25),
      sharpenEdgeMasking: p.int('crs:SharpenEdgeMasking', 0, 100, 0),
      luminanceSmoothing: p.int('crs:LuminanceSmoothing', 0, 100, 0),
      luminanceNoiseReductionDetail: p.int('crs:LuminanceNoiseReductionDetail', 0, 100, 50),
      luminanceNoiseReductionContrast: p.int('crs:LuminanceNoiseReductionContrast', 0, 100, 0),
      colorNoiseReduction: p.int('crs:ColorNoiseReduction', 0, 100, 25),
      colorNoiseReductionDetail: p.int('crs:ColorNoiseReductionDetail', 0, 100, 50),
      colorNoiseReductionSmoothness: p.int('crs:ColorNoiseReductionSmoothness', 0, 100, 50),
    },

    colorGrading: {
      splitToningShadowHue: p.int('crs:SplitToningShadowHue', 0, 360, 0),
      splitToningShadowSaturation: p.int('crs:SplitToningShadowSaturation', 0, 100, 0),
      splitToningHighlightHue: p.int('crs:SplitToningHighlightHue', 0, 360, 0),
      splitToningHighlightSaturation: p.int('crs:SplitToningHighlightSaturation', 0, 100, 0),
      splitToningBalance: p.int('crs:SplitToningBalance', -100, 100, 0),
      colorGradeShadowLuminance: p.int('crs:ColorGradeShadowLum', -100, 100, 0),
      colorGradeMidtoneHue: p.int('crs:ColorGradeMidtoneHue', 0, 360, 0),
      colorGradeMidtoneSaturation: p.int('crs:ColorGradeMidtoneSat', 0, 100, 0),
      colorGradeMidtoneLuminance: p.int('crs:ColorGradeMidtoneLum', -100, 100, 0),
      colorGradeHighlightLuminance: p.int('crs:ColorGradeHighlightLum', -100, 100, 0),
      colorGradeGlobalHue: p.int('crs:ColorGradeGlobalHue', 0, 360, 0),
      colorGradeGlobalSaturation: p.int('crs:ColorGradeGlobalSat', 0, 100, 0),
      colorGradeGlobalLuminance: p.int('crs:ColorGradeGlobalLum', -100, 100, 0),
      colorGradeBlending: p.int('crs:ColorGradeBlending', 0, 100, 50),
    },

    lens: {
      lensProfileEnable: p.flag('crs:LensProfileEnable', false),
      lensProfileSetup: p.enumeration('crs:LensProfileSetup', LENS_PROFILE_SETUPS, 'LensDefaults'),
      lensProfileName: p.text('crs:LensProfileName'),
      lensProfileFilename: p.text('crs:LensProfileFilename'),
      lensProfileDigest: p.text('crs:LensProfileDigest'),
      lensProfileIsEmbedded: p.flag('crs:LensProfileIsEmbedded', false),
      lensProfileDistortionScale: p.int('crs:LensProfileDistortionScale', 0, 200, 100),
      lensProfileChromaticAberrationScale: p.int('crs:LensProfileChromaticAberrationScale', 0, 200, 100),
      lensProfileVignettingScale: p.int('crs:LensProfileVignettingScale', 0, 200, 100),
      lensManualDistortionAmount: p.int('crs:LensManualDistortionAmount', -100, 100, 0),
      autoLateralCA: p.flag('crs:AutoLateralCA', false),
      chromaticAberrationR: p.int('crs:ChromaticAberrationR', -100, 100, 0),
      chromaticAberrationB: p.int('crs:ChromaticAberrationB', -100, 100, 0),
      defringePurpleAmount: p.int('crs:DefringePurpleAmount', 0, 20, 0),
      defringePurpleHueLo: p.int('crs:DefringePurpleHueLo', 0, 100, 30),
      defringePurpleHueHi: p.int('crs:DefringePurpleHueHi', 0, 100, 70),
      defringeGreenAmount: p.int('crs:DefringeGreenAmount', 0, 20, 0),
      defringeGreenHueLo: p.int('crs:DefringeGreenHueLo', 0, 100, 40),
      defringeGreenHueHi: p.int('crs:DefringeGreenHueHi', 0, 100, 60),
    },

    effects: {
      vignetteAmount: p.int('crs:VignetteAmount', -100, 100, 0),
      vignetteMidpoint: p.int('crs:VignetteMidpoint', 0, 100, 50),
      postCropVignetteAmount: p.int('crs:PostCropVignetteAmount', -100, 100, 0),
      postCropVignetteMidpoint: p.int('crs:PostCropVignetteMidpoint', 0, 100, 50),
      postCropVignetteFeather: p.int('crs:PostCropVignetteFeather', 0, 100, 50),
      postCropVignetteRoundness: p.int('crs:PostCropVignetteRoundness', -100, 100, 0),
      postCropVignetteStyle: p.enumInt('crs:PostCropVignetteStyle', [1, 2, 3], 1),
      postCropVignetteHighlightContrast: p.int('crs:PostCropVignetteHighlightContrast', 0, 100, 0),
      grainAmount: p.int('crs:GrainAmount', 0, 100, 0),
      grainSize: p.int('crs:GrainSize', 0, 100, 25),
      grainFrequency: p.int('crs:GrainFrequency', 0, 100, 50),
      grainSeed: p.int('crs:GrainSeed', -ANY, ANY, 0),
    },

    calibration: {
      shadowTint: p.int('crs:ShadowTint', -100, 100, 0),
      redHue: p.int('crs:RedHue', -100, 100, 0),
      redSaturation: p.int('crs:RedSaturation', -100, 100, 0),
      greenHue: p.int('crs:GreenHue', -100, 100, 0),
      greenSaturation: p.int('crs:GreenSaturation', -100, 100, 0),
      blueHue: p.int('crs:BlueHue', -100, 100, 0),
      blueSaturation: p.int('crs:BlueSaturation', -100, 100, 0),
    },

    geometry: {
      orientation: p.enumIntOrNull('tiff:Orientation', [1, 2, 3, 4, 5, 6, 7, 8]),
      hasCrop: cropped,
      cropTop: cropped ? cropTop : 0,
      cropLeft: cropped ? cropLeft : 0,
      cropBottom: cropped ? cropBottom : 1,
      cropRight: cropped ? cropRight : 1,
      cropAngle: cropped ? cropAngle : 0,
      cropWidth: p.realOrNull('crs:CropWidth', -ANY, ANY),
      cropHeight: p.realOrNull('crs:CropHeight', -ANY, ANY),
      cropUnits,
      cropConstrainToWarp: p.flag('crs:CropConstrainToWarp', false),
      perspectiveVertical: p.int('crs:PerspectiveVertical', -100, 100, 0),
      perspectiveHorizontal: p.int('crs:PerspectiveHorizontal', -100, 100, 0),
      perspectiveRotate: p.real('crs:PerspectiveRotate', -10, 10, 0),
      perspectiveScale: p.int('crs:PerspectiveScale', 50, 150, 100),
      perspectiveAspect: p.int('crs:PerspectiveAspect', -100, 100, 0),
      perspectiveX: p.real('crs:PerspectiveX', -100, 100, 0),
      perspectiveY: p.real('crs:PerspectiveY', -100, 100, 0),
      perspectiveUpright: p.enumInt('crs:PerspectiveUpright', [0, 1, 2, 3, 4, 5], 0),
      uprightVersion: p.intOrNull('crs:UprightVersion', -ANY, ANY),
      uprightCenterMode: p.intOrNull('crs:UprightCenterMode', -ANY, ANY),
      uprightCenterNormX: p.realOrNull('crs:UprightCenterNormX', 0, 1),
      uprightCenterNormY: p.realOrNull('crs:UprightCenterNormY', 0, 1),
      uprightFocalMode: p.intOrNull('crs:UprightFocalMode', -ANY, ANY),
      uprightFocalLength35mm: p.realOrNull('crs:UprightFocalLength35mm', -ANY, ANY),
      uprightTransformCount: p.intOrNull('crs:UprightTransformCount', -ANY, ANY),
      uprightFourSegmentsCount: p.intOrNull('crs:UprightFourSegmentsCount', -ANY, ANY),
    },

    profile: {
      cameraProfile: p.text('crs:CameraProfile'),
      cameraProfileDigest: p.text('crs:CameraProfileDigest'),
    },

    // `crs:LookName`, which some writers emit alongside the structure, is a
    // different property at a different depth and is deliberately not merged
    // into this; it stays unread and is reported in `unsupported`.
    look: lookFields == null ? null : {
      name: lookFields.text('crs:Name'),
      amount: lookFields.realOrNull('crs:Amount', -ANY, ANY),
      uuid: lookFields.text('crs:UUID'),
      group: lookFields.langAlt('crs:Group'),
      cluster: lookFields.text('crs:Cluster'),
      copyright: lookFields.text('crs:Copyright'),
      supportsAmount: lookFields.flagOrNull('crs:SupportsAmount'),
      supportsMonochrome: lookFields.flagOrNull('crs:SupportsMonochrome'),
      supportsOutputReferred: lookFields.flagOrNull('crs:SupportsOutputReferred'),
      // `crs:Parameters` and its opaque `crs:LookTable` are left unread, which
      // names them in `unsupported`: a look's own parameter set is of no use
      // until looks are rendered, and the sidecar can be re-read then.
    },

    metadata: {
      rating: p.realOrNull('xmp:Rating', -1, 5),
      label: p.text('xmp:Label'),
      createDate: p.date('xmp:CreateDate'),
      modifyDate: p.date('xmp:ModifyDate'),
      metadataDate: p.date('xmp:MetadataDate'),
      subject: p.strings('dc:subject'),
      hierarchicalSubject: p.strings('lr:hierarchicalSubject'),
      title: p.langAlt('dc:title'),
      description: p.langAlt('dc:description'),
      creator: p.strings('dc:creator'),
      rights: p.langAlt('dc:rights'),
      dateCreated: p.date('photoshop:DateCreated'),
      sidecarForExtension: p.text('photoshop:SidecarForExtension'),
      rawFileName: p.text('crs:RawFileName'),
    },

    legacyTone: !legacy ? null : {
      exposure: p.real('crs:Exposure', -4, 4, 0),
      // Null rather than the tabulated default where that default is
      // unconfirmed: on these four an absent tag does not mean neutral, so a
      // wrong non-zero number would be applied as though it had been measured.
      brightness: p.intOrNull('crs:Brightness', 0, 150),
      contrast: p.intOrNull('crs:Contrast', -50, 100),
      shadows: p.intOrNull('crs:Shadows', 0, 100),
      highlightRecovery: p.int('crs:HighlightRecovery', 0, 100, 0),
      fillLight: p.int('crs:FillLight', 0, 100, 0),
      clarity: p.int('crs:Clarity', -100, 100, 0),
      curve: p.curve('crs:ToneCurve'),
      curveName: p.enumerationOrNull('crs:ToneCurveName', TONE_CURVE_NAMES),
      curveRed: p.curve('crs:ToneCurveRed'),
      curveGreen: p.curve('crs:ToneCurveGreen'),
      curveBlue: p.curve('crs:ToneCurveBlue'),
    },

    unsupported: [...new Set([...p.unsupported(), ...(lookFields?.unsupported() ?? [])])].sort(),
    issues,
  };

  return XmpSettingsSchema.parse(settings);
}
