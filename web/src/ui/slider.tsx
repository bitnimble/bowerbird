import { Slider as BaseSlider } from '@base-ui-components/react/slider';
import * as stylex from '@stylexjs/stylex';
import { type PointerEvent, useContext, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { focusRing } from './focus_ring';
import { SliderStrings } from './slider.strings';
import { SliderIsolationContext } from './slider_isolation';
import { color, font, size } from './tokens.stylex';

const DISABLED = '[data-disabled]';

/** Where the temperature track paints its neutral grey, in percent: the raw editor puts 5500K there. */
export const TEMPERATURE_GREY_AT = 50;

const styles = stylex.create({
  root: {
    width: '110px',
    display: 'flex',
    alignItems: 'center',
    height: size.controlH,
    opacity: { default: null, [DISABLED]: 0.35 },
    pointerEvents: { default: null, [DISABLED]: 'none' },
  },
  control: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    height: '100%',
    cursor: 'pointer',
    touchAction: 'none',
  },
  track: {
    position: 'relative',
    width: '100%',
    height: '3px',
    borderRadius: '2px',
    backgroundColor: color.slate,
  },
  temperature: {
    backgroundImage: `linear-gradient(to right, #4d7fd4, #8f9ba8 ${TEMPERATURE_GREY_AT}%, #d9a33f)`,
  },
  tint: {
    backgroundImage: 'linear-gradient(to right, #58ad72, #8f9ba8, #b06fc4)',
  },
  fill: {
    position: 'absolute',
    height: '100%',
    borderRadius: '2px',
    backgroundColor: color.satin,
  },
  snap: {
    position: 'absolute',
    top: '-3px',
    width: '1px',
    height: '9px',
    transform: 'translateX(-50%)',
    backgroundColor: color.boneDim,
    opacity: 0.45,
  },
  thumb: {
    position: 'relative',
    width: '11px',
    height: '11px',
    borderRadius: '50%',
    backgroundColor: color.bone,
    // A grab bigger than the dot, for a finger only: at a cursor the row is 30px and this would hang
    // out of it. Up and down only: sideways it took the taps meant for whatever sits alongside.
    '::before': {
      content: { default: null, '@media (pointer: coarse)': '""' },
      position: 'absolute',
      inset: '-16px 0',
    },
  },
  isolated: {
    position: 'fixed',
    zIndex: 70,
    pointerEvents: 'none',
    color: color.bone,
    backgroundColor: color.bower,
    borderRadius: size.radius,
    boxShadow: `0 0 0 8px ${color.bower}`,
  },
  readout: {
    position: 'absolute',
    bottom: '100%',
    left: '-8px',
    right: '-8px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    padding: '6px 8px',
    backgroundColor: color.bower,
    borderRadius: size.radius,
    fontFamily: font.body,
    fontSize: '13px',
  },
  readoutValue: {
    fontFamily: font.mono,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  isolatedThumb: {
    position: 'absolute',
    top: '50%',
    translate: '-50% -50%',
  },
});

/**
 * How near a snap point a pointer has to come to land on it, in pixels of track.
 *
 * A pointer cannot hit an exact value, so a slider with a meaningful rest position is one the
 * reader can never get back to by hand. A pointer either way it arrives - a drag, or a press on
 * the track that jumps there - but never a keypress, which asks for a specific value and must be
 * given it, or the arrow keys cannot walk past zero.
 *
 * **In pixels, because a pointer moves in pixels.** A window written as a share of the range, or
 * in the control's own units, is a guess about how wide the control will be laid out, and the
 * straighten is where that guess is unforgiving: ±45° across a 298px panel column is 0.3° of
 * angle per pixel of track, so any window under half a degree is one nobody can land in.
 *
 * **Wider under a finger**, which covers the anchor it is aiming for and rolls a few pixels as it
 * lifts: at 3 a touch drag almost never lands.
 */
const SNAP_PIXELS = { mouse: 3, touch: 12 };

export function Slider({
  value,
  onChange,
  onCommit,
  min,
  max,
  step,
  label,
  disabled,
  origin,
  snap,
  tone,
  valueText,
  focusable = true,
  style,
}: {
  value: number;
  onChange: (value: number) => void;
  /**
   * The drag finished, by pointer or by key.
   *
   * Only for controls whose two ends cost different amounts - an exposure drag previews
   * small and settles at full resolution. Where every value costs the same, `onChange`
   * alone is the whole story.
   */
  onCommit?: (value: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
  disabled?: boolean;
  /**
   * Where the fill starts, which is not where the control rests and not where it snaps.
   *
   * Zero by default and clamped to the track, so a signed slider fills out of its middle and
   * a 0-to-100 one out of its left end - including where that one rests somewhere else, which
   * is a bar the reader can see at rest rather than an empty track.
   */
  origin?: number;
  /**
   * The values a drag lands on, each marked with a tick.
   *
   * A list because a track can have more than one landmark: where the control rests, and any
   * other position worth being able to return to by hand.
   */
  snap?: readonly number[];
  /**
   * The track painted as what the control does, for a slider whose two ends are colours.
   *
   * The white balance pair only: which way is warmer and which way is greener is the one
   * thing about them a label cannot say faster than the track can. A toned track carries no
   * fill - there is nothing for a bar to add to a gradient that already reads as a scale.
   */
  tone?: 'temperature' | 'tint';
  /**
   * What the position is announced as, for a track whose own units are not the reader's.
   *
   * The temperature slider only, which is laid out in mireds and read in Kelvin: everywhere
   * else the number the control holds is the number on the label beside it.
   */
  valueText?: (value: number) => string;
  /**
   * Off inside a menu popup, where the first tabbable element takes the focus the
   * menu's own items need: a slider there leaves every action in the popup
   * unreachable by keyboard, and no arrow key ever gets past the track.
   */
  focusable?: boolean;
  /** On the root, whose height the control inside it takes. */
  style?: stylex.StyleXStyles;
}): JSX.Element {
  const share = (at: number): number => Math.min(Math.max(((at - min) / (max - min)) * 100, 0), 100);
  const from = share(origin ?? 0);
  const to = share(value);
  const id = useId();
  const isolation = useContext(SliderIsolationContext);
  const endIsolation = isolation?.end;
  const active = isolation?.active;
  const isolated = active?.id === id ? active : null;
  const pointer = useRef<number | null>(null);

  useEffect(() => () => {
    pointer.current = null;
    endIsolation?.(id);
  }, [endIsolation, id]);

  const finishIsolation = (event: PointerEvent<HTMLDivElement>): void => {
    if (pointer.current !== event.pointerId) return;
    pointer.current = null;
    endIsolation?.(id);
  };

  const control = useRef<HTMLDivElement>(null);
  // Observed rather than measured where it is used: `held` runs on every move of a drag, and a
  // `getBoundingClientRect` there is a layout read on the hottest path this component has.
  const across = useRef(0);
  useEffect(() => {
    const element = control.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null) across.current = entry.contentRect.width;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const held = (next: number, { reason, event }: { reason: string; event: Event }): number => {
    if (reason !== 'drag' && reason !== 'track-press') return next;
    // Before the first observation there is no width to be a pixel of, and a snap window of
    // infinity would pin the control to its landmark.
    if (across.current === 0) return next;
    const finger = 'touches' in event || ('pointerType' in event && event.pointerType === 'touch');
    const within = ((max - min) / across.current) * SNAP_PIXELS[finger ? 'touch' : 'mouse'];
    return snap?.find((at) => Math.abs(next - at) < within) ?? next;
  };

  return (
    <>
      <BaseSlider.Root
        {...stylex.props(styles.root, style)}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onPointerDownCapture={(event) => {
          if (isolation == null || disabled || event.button !== 0 || !event.isPrimary || event.defaultPrevented
            || pointer.current != null) return;
          const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
          pointer.current = event.pointerId;
          isolation.begin(id, { left, top, width, height });
        }}
        onPointerUp={finishIsolation}
        onPointerCancel={finishIsolation}
        onLostPointerCapture={finishIsolation}
        onValueChange={(next, details) => {
          if (typeof next === 'number') onChange(held(next, details));
        }}
        onValueCommitted={(next, details) => {
          if (typeof next === 'number') onCommit?.(held(next, details));
        }}
      >
        <BaseSlider.Control {...stylex.props(styles.control)} ref={control}>
          <BaseSlider.Track {...stylex.props(styles.track, tone != null && styles[tone])}>
            <SliderMarks snap={snap} share={share} tone={tone} from={from} to={to} />
            {/* On the thumb, which is what carries the range input: the control around it is a
                plain div, so a name left there reaches nothing that announces a value. */}
            <BaseSlider.Thumb
              {...stylex.props(styles.thumb, focusRing.within)}
              aria-label={label}
              getAriaValueText={valueText == null ? undefined : (_formatted, at) => valueText(at)}
              tabIndex={focusable ? undefined : -1}
            />
          </BaseSlider.Track>
        </BaseSlider.Control>
      </BaseSlider.Root>
      {isolated != null && createPortal(
        <div
          {...stylex.props(styles.root, styles.isolated)}
          style={isolated.rectangle}
          role="region"
          aria-label={SliderStrings.adjusting(label)}
        >
          <div {...stylex.props(styles.readout)}>
            <span>{label}</span>
            <span {...stylex.props(styles.readoutValue)}>{valueText?.(value) ?? value}</span>
          </div>
          <div {...stylex.props(styles.control)} aria-hidden="true">
            <div {...stylex.props(styles.track, tone != null && styles[tone])}>
              <SliderMarks snap={snap} share={share} tone={tone} from={from} to={to} />
              <span {...stylex.props(styles.thumb, styles.isolatedThumb)} style={{ left: `${to}%` }} />
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function SliderMarks({ snap, share, tone, from, to }: {
  snap: readonly number[] | undefined;
  share: (value: number) => number;
  tone: 'temperature' | 'tint' | undefined;
  from: number;
  to: number;
}): JSX.Element {
  return (
    <>
      {snap?.map((at) => (
        <span key={at} {...stylex.props(styles.snap)} style={{ left: `${share(at)}%` }} />
      ))}
      {tone == null && (
        <span
          {...stylex.props(styles.fill)}
          style={{ left: `${Math.min(from, to)}%`, width: `${Math.abs(to - from)}%` }}
        />
      )}
    </>
  );
}
