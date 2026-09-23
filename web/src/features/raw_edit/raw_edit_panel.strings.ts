import type { EditStatus } from './stage/stage_store';

export const RawEditPanelStrings = {
  guideVertical: () => 'Vertical',
  guideHorizontal: () => 'Horizontal',

  exposure: () => 'Exposure',
  exposureUnit: () => ' EV',
  contrast: () => 'Contrast',
  highlights: () => 'Highlights',
  whites: () => 'Whites',
  shadows: () => 'Shadows',
  blacks: () => 'Blacks',
  vibrance: () => 'Vibrance',
  saturation: () => 'Saturation',
  texture: () => 'Texture',
  clarity: () => 'Clarity',
  dehaze: () => 'Dehaze',
  luminance: () => 'Luminance',
  // The denoise's colour half. Not `groupColour`, which is the vibrance and
  // saturation panel: renaming one must not rename the other.
  colour: () => 'Colour',
  sharpening: () => 'Sharpening',
  sensitivity: () => 'Sensitivity',
  intensity: () => 'Intensity',

  /** A slider's number, signed only where the track has a negative half. */
  reading: (sign: string, value: string) => `${sign}${value}`,
  valueWithUnit: (reading: string, unit: string) => `${reading}${unit}`,

  rebuildingThePhoto: () => 'Rebuilding the photo…',

  removeSensorDust: () => 'Remove sensor dust',

  noWhiteBalanceMode: () => '-',
  noCameraNeutral: () => 'Camera white balance unavailable for this file',
  noMosaic: () => 'Denoise unavailable for developed photos',
  // Said of the sensor rather than of the photograph: every frame from this body answers the same
  // way, and a reader who has just watched two sliders disappear wants to know it is the camera.
  noDenoise: () => "Denoise unavailable for this camera's sensor",
  temperature: () => 'Temperature',
  kelvin: (temperature: number) => `${temperature} K`,
  tint: () => 'Tint',

  aspectRatio: () => 'Aspect ratio',
  // The frame's own shape. The ratios beside it are their own labels, being notation
  // rather than words.
  aspectOriginal: () => 'Original',
  aspectCustom: () => 'Custom',

  straighten: () => 'Straighten',
  degrees: (reading: string) => `${reading}°`,
  percent: (reading: string) => `${reading}%`,
  cropToFit: () => 'Crop to fit',

  guidesToDraw: () => 'Guides to draw',
  drawFirstGuide: (kind: 'vertical' | 'horizontal') =>
    `Draw a guide along an edge that is ${kind === 'vertical' ? 'upright' : 'level'} in life.`,
  drawSecondGuide: () => 'Draw another guide along a parallel edge.',
  pairCorrected: () => 'Perspective corrected. Draw 2 guides for the other axis.',
  guideName: (kind: 'vertical' | 'horizontal', index: number) =>
    `${kind === 'vertical' ? 'Vertical' : 'Horizontal'} ${index}`,
  removeGuide: (kind: 'vertical' | 'horizontal', index: number) => `Remove ${kind} guide ${index}`,
  removeThisGuide: () => 'Remove this guide',
  clearGuides: () => 'Clear guides',

  drawAroundToRemove: () => 'Draw around what to remove',
  findingFills: () => 'Finding fills…',
  nothingToFillFrom: () => 'Nothing nearby to fill it from',
  fills: () => 'Fills',
  fillOption: (index: number) => `Fill ${index}`,
  applyFill: () => 'Apply',
  cancelFill: () => 'Cancel',
  editRepair: (index: number) => `Edit removal ${index}`,
  deleteRepair: (index: number) => `Delete removal ${index}`,
  showOutlines: () => 'Show outlines',
  expandToHideSeam: () => 'Expand selection to hide seam better',

  status: (status: EditStatus) =>
    status === 'fetching' ? 'Fetching'
    : status === 'preparing' ? 'Preparing'
    : status === 'live' ? 'Ready'
    : status === 'failed' ? 'Unavailable'
    : 'Idle',
  statusWithMessage: (status: string, message: string) => `${status}. ${message}`,

  editedElsewhere: () => 'These edits changed on another device. Reopen this photo to see them.',
  couldNotSave: () => "We couldn't save your edits. Try again.",

  groupLight: () => 'Light',
  groupWhiteBalance: () => 'White balance',
  groupColour: () => 'Colour',
  groupEffects: () => 'Effects',
  groupDetail: () => 'Detail',
  groupDustRemoval: () => 'Dust removal',
  groupGeometry: () => 'Geometry',

  colourProfile: () => 'Colour profile',
  colourProfileNone: () => 'None',
  colourProfileMatched: () => 'Matched',

  denoiser: () => 'Denoiser',
  denoiserGalosh: () => 'GALOSH',
  denoiserPmrid: () => 'PMRID',
};
