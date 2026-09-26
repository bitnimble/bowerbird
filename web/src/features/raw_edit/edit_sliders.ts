// Its own module, apart from the panel that draws them, because `edit_rows` reads these and is
// pure: a test of a pure function pulls no component, and a component here pulls Base UI, which
// decides once at import whether it has a DOM. Imported before a suite's `registerDom()`, it
// decides no - and every popover in the whole process then renders unwired.
import { type EditDoc } from '../../../../src/schemas/photo_edits';
import { RawEditPanelStrings } from './raw_edit_panel.strings';

const EV_RANGE = 5;

export interface SliderSpec {
  key: keyof EditDoc & string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** What the number reads in, where it is not a bare slider position. */
  unit?: string;
  /**
   * Where the reset arrow and the snap go, and what counts as untouched.
   *
   * Zero for every slider that runs either side of nothing. The dust pair and the sharpen are what
   * make this a field: all three are wanted by default, so resetting them to 0 would hand back an
   * uncorrected picture and call that neutral.
   */
  neutral?: number;
  /**
   * Whether the *photograph* answers where the document holds null, rather than a fixed default.
   *
   * Exposure comes from the camera match and the Detail pair from the noise fit where the
   * document stores null. Reset keeps the measured value following the photograph.
   */
  measured?: boolean;
}

/**
 * The sliders, grouped as a reader thinks of them and at the ranges `EditDoc` stores.
 *
 * The exposure is the only one that steps by a hundredth, EV being a unit a reader means a
 * fraction of. `dehaze` is a real in the document because `crs:Dehaze` is one and an import
 * has to round-trip it, but a control that reads `+40.00` beside four neighbours reading
 * `+40` is stating a precision nobody asked for - so it is stepped like them.
 *
 * The tone four are Camera Raw's order, which Capture One's HDR tool also has: the pair that
 * recover a range, then the pair that set where the range ends. Not lightest to darkest - a
 * reader arriving from either program reaches for the fourth row expecting Whites, and the
 * labels are that program's labels, so the column has to be as well.
 */
export const LIGHT: readonly SliderSpec[] = [
  {
    key: 'exposure',
    label: RawEditPanelStrings.exposure(),
    min: -EV_RANGE,
    max: EV_RANGE,
    step: 0.01,
    unit: RawEditPanelStrings.exposureUnit(),
    measured: true,
  },
  { key: 'contrast', label: RawEditPanelStrings.contrast(), min: -100, max: 100, step: 1 },
  { key: 'highlights', label: RawEditPanelStrings.highlights(), min: -100, max: 100, step: 1 },
  { key: 'shadows', label: RawEditPanelStrings.shadows(), min: -100, max: 100, step: 1 },
  { key: 'whites', label: RawEditPanelStrings.whites(), min: -100, max: 100, step: 1 },
  { key: 'blacks', label: RawEditPanelStrings.blacks(), min: -100, max: 100, step: 1 },
];

export const COLOUR: readonly SliderSpec[] = [
  { key: 'vibrance', label: RawEditPanelStrings.vibrance(), min: -100, max: 100, step: 1 },
  { key: 'saturation', label: RawEditPanelStrings.saturation(), min: -100, max: 100, step: 1 },
];

export const EFFECTS: readonly SliderSpec[] = [
  { key: 'texture', label: RawEditPanelStrings.texture(), min: -100, max: 100, step: 1 },
  { key: 'clarity', label: RawEditPanelStrings.clarity(), min: -100, max: 100, step: 1 },
  { key: 'dehaze', label: RawEditPanelStrings.dehaze(), min: -100, max: 100, step: 1 },
];

/**
 * The denoise, as Camera Raw's Detail panel names its two halves, and the sharpen that runs
 * below them.
 *
 * **0 to 100 rather than -100 to 100**, unlike every slider above: there is no such thing as
 * negative noise reduction, and a snap point in the middle of a track whose left half does not
 * exist would invite one. Luminance's landmark is its middle, where it removes exactly the noise
 * the frame was measured to have; colour's are its thirds, one per level of the chroma pyramid it
 * walks.
 *
 * **The denoise pair start wherever the photograph puts them**, which is why neither carries a
 * neutral: a position is a fraction of a track and what a reader sees at one is that fraction of
 * however much noise the frame had, so the module resolves them off its own fit and the row shows
 * what it resolved. Colour lands further along than luminance on any given frame, because the
 * failures are not symmetric: grain in luma still reads as a photograph and the over-reach that
 * removes it smears texture, where colour mottle has no such defence.
 *
 * **Sharpening below both**, in the order the stages run: the deconvolution inverts a blur, and
 * grain left in the frame is a thing it will invert as readily.
 */
export const DETAIL: readonly SliderSpec[] = [
  { key: 'luminanceNoise', label: RawEditPanelStrings.luminance(), min: 0, max: 100, step: 1, measured: true },
  { key: 'colourNoise', label: RawEditPanelStrings.colour(), min: 0, max: 100, step: 1, measured: true },
  { key: 'sharpening', label: RawEditPanelStrings.sharpening(), min: 0, max: 100, step: 1, neutral: 50 },
];

/**
 * The dust pair, which only mean anything once the switch beside them is on.
 *
 * **Sensitivity is a confidence, not a strength**, and it runs the whole way because that is where
 * the two populations sit: over smooth sky a particle and a mark on the picture are separable, and
 * over lichen-covered rock they are not, so a reader who wants only the certain ones and a reader
 * who wants every smudge are asking for two ends of one axis.
 *
 * **Intensity exists because the correction can be right about where and wrong about how much.**
 * The shadow's depth is measured off the frame, but through a stack height the body does not
 * record - so a spot that comes back slightly light or slightly dark is a knob rather than a bug
 * report. Full is the default: the measurement is usually right.
 */
export const DUST: readonly SliderSpec[] = [
  { key: 'dustSensitivity', label: RawEditPanelStrings.sensitivity(), min: 0, max: 100, step: 1, neutral: 25 },
  { key: 'dustIntensity', label: RawEditPanelStrings.intensity(), min: 0, max: 100, step: 1, neutral: 100 },
];

/** Every slider whose value is a plain number, in the order the panel shows them. */
export const EDIT_SLIDERS: readonly SliderSpec[] = [...LIGHT, ...COLOUR, ...EFFECTS, ...DETAIL];

/// Signed only where the track has a negative half; `+33` on a 0-to-100 slider states a
/// direction it has no opposite of.
///
/// Takes the two fields it reads rather than a whole spec, because the controls outside the
/// groups above - the balance pair, the straighten - have no `SliderSpec` to hand.
export function reading(value: number, { min, step }: Pick<SliderSpec, 'min' | 'step'>): string {
  const sign = min < 0 && value > 0 ? '+' : '';
  const places = (String(Number(value.toFixed(TYPED_PLACES))).split('.')[1] ?? '').length;
  return RawEditPanelStrings.reading(sign, step < 1 ? value.toFixed(Math.max(places, 2)) : String(value));
}

const TYPED_PLACES = 4;

export interface TypedRange extends Pick<SliderSpec, 'min' | 'max' | 'step'> {
  /** What the readout multiplies the stored value by: 100 for a fraction shown as a percentage. */
  scale?: number;
}

/**
 * The number typed into a control's readout, in the value's stored units and held to its range, or
 * null where the text holds none. Units, a sign and thousands separators may come with it, as the
 * readout shows them.
 */
export function typedValue(text: string, { min, max, step, scale = 1 }: TypedRange): number | null {
  const number = /[-+]?\d*\.?\d+/.exec(text.replace('−', '-').replaceAll(',', ''));
  if (number == null) return null;
  const held = Math.min(Math.max(Number(Number(number[0]).toFixed(TYPED_PLACES)) / scale, min), max);
  // A whole step is a field `EditDoc` stores as an integer.
  return step >= 1 ? Math.round(held) : held;
}

export function snapped(value: number, { step }: Pick<SliderSpec, 'step'>): number {
  return Number((Math.round(value / step) * step).toFixed(TYPED_PLACES));
}

export function sliderValue(value: number, spec: Pick<SliderSpec, 'measured'>, neutral: number): number | null {
  return spec.measured === true && value === neutral ? null : value;
}
