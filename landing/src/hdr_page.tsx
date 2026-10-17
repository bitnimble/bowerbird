import * as stylex from '@stylexjs/stylex';
import type { MDXComponents } from 'mdx/types';
import { Fragment, createContext, useContext, useState, type ReactNode } from 'react';
import { HdrPicture } from '../../web/src/avif/hdr_picture';
import { focusRing } from '../../web/src/ui/focus_ring';
import { Heading } from '../../web/src/ui/heading';
import { Text } from '../../web/src/ui/text';
import { color, font, size } from '../../web/src/ui/tokens.stylex';
import HdrPageCopy from './copy/hdr.mdx';
import { useHdrDisplay } from './hdr_display';
import { HdrPageStrings } from './hdr_page.strings';
import { PHOTOS, SWATCHES, hdrSource, type Scene as SceneName } from './photos';
import { InParagraph, Paragraph } from './prose';
import { mount } from './site';

const NARROW = '@media (max-width: 640px)';
// Wide enough that the chart still has a track after the prose column and its own 190px of labels.
const SPLIT = '@media (min-width: 1400px)';

const styles = stylex.create({
  at: (left: string) => ({ left }),

  text: {
    maxWidth: '62ch',
  },
  p: {
    marginTop: 0,
    marginInline: 0,
    marginBottom: '14px',
    lineHeight: 1.55,
  },
  pInScene: {
    marginBottom: 0,
  },
  h2: {
    marginTop: '30px',
  },
  // Level with the other column's heading once they stand side by side.
  h2OpensColumn: {
    marginTop: { default: '30px', [SPLIT]: 0 },
  },
  split: {
    display: 'grid',
    gap: '0 44px',
    alignItems: 'start',
    marginTop: '30px',
    gridTemplateColumns: { default: null, [SPLIT]: 'minmax(0, 48ch) minmax(0, 1fr)' },
  },
  // Two across where there is room, so four pictures make a block rather than a row of
  // three and an orphan.
  scenes: {
    display: 'grid',
    gap: '40px 32px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))',
    marginTop: '20px',
  },
  // A shared pair of rows, or captions of different lengths start the three pictures at three heights.
  scene: {
    display: { default: 'grid', '@supports not (grid-template-rows: subgrid)': 'block' },
    gridTemplateRows: 'subgrid',
    gridRow: 'span 2',
    rowGap: '10px',
  },
  note: {
    lineHeight: 1.6,
    color: color.boneDim,
    borderLeftWidth: '2px',
    borderLeftStyle: 'solid',
    borderLeftColor: color.slate,
    paddingLeft: '10px',
  },
  notice: {
    backgroundColor: color.slateSoft,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderLeftWidth: '2px',
    borderLeftColor: color.ochre,
    borderRadius: size.radius,
    paddingBlock: '2px',
    paddingInline: '12px',
    marginBottom: '16px',
  },

  stops: {
    marginTop: '4px',
    marginInline: 0,
    marginBottom: '14px',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: { default: '190px 1fr 62px', [NARROW]: '1fr' },
    alignItems: 'center',
    gap: { default: '10px', [NARROW]: '2px' },
    marginBottom: { default: '6px', [NARROW]: '12px' },
  },
  rowUnder: {
    marginBottom: { default: '2px', [NARROW]: '12px' },
  },
  label: {
    fontSize: '14.3px',
  },
  labelUnder: {
    paddingLeft: '14px',
    fontSize: '13.2px',
    color: color.boneDim,
  },
  track: {
    position: 'relative',
    height: '16px',
  },
  trackUnder: {
    height: '10px',
  },
  tick: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '1px',
    backgroundColor: color.slate,
  },
  tickWhite: {
    width: '2px',
    marginLeft: '-1px',
    backgroundColor: color.bone,
    zIndex: 1,
    top: '-3px',
    bottom: '-3px',
  },
  bar: {
    position: 'absolute',
    top: '2px',
    bottom: '2px',
    borderRadius: '2px',
  },
  barUnder: {
    top: '3px',
    bottom: '3px',
    opacity: 0.55,
  },
  eye: { backgroundColor: color.glass },
  sensor: { backgroundColor: color.moss },
  hdr: { backgroundColor: color.satin },
  sdr: { backgroundColor: color.ochre },
  over: {
    position: 'absolute',
    top: '2px',
    bottom: '2px',
    borderRadius: '0 2px 2px 0',
    backgroundImage:
      'repeating-linear-gradient(-45deg, rgba(11, 13, 17, 0.55) 0 2px, transparent 2px 5px)',
  },
  overUnder: {
    top: '3px',
    bottom: '3px',
  },
  count: {
    textAlign: { default: 'right', [NARROW]: 'left' },
  },
  axis: {
    position: 'relative',
    height: '14px',
  },
  axisTick: {
    position: 'absolute',
    transform: 'translateX(-50%)',
  },

  swatches: {
    marginTop: '12px',
    marginInline: 0,
    marginBottom: 0,
  },
  swatchesImage: {
    display: 'block',
    width: '100%',
    height: 'auto',
    // Not a hint: Safari composites a PQ image in a scroller into its shared SDR backing store,
    // flat, unless it has a layer of its own (DESIGN §10.7).
    willChange: 'opacity',
  },
  swatchesCaption: {
    display: 'flex',
    marginTop: '4px',
  },
  swatchesHalf: {
    flex: 1,
  },
  swatchesHalfRight: {
    textAlign: 'right',
  },

  compare: {
    margin: 0,
  },
  frame: {
    position: 'relative',
    display: 'block',
    width: 'fit-content',
    maxWidth: '100%',
    marginBlock: 0,
    marginInline: 'auto',
    padding: 0,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: size.radius,
    // Black, not the page's: an HDR frame is judged against what surrounds it.
    backgroundColor: '#000',
    overflow: 'hidden',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  // Both mounted and decoded, swapped by opacity: `will-change` keeps the hidden one rasterised so
  // a press costs no repaint. No filter, transform or partial opacity here or above: any of them
  // rasterises into an SDR intermediate and the PQ tagging is silently lost.
  layer: {
    opacity: 0,
    willChange: 'opacity',
  },
  layerUp: {
    opacity: 1,
  },
  layerBase: {
    display: 'block',
    width: 'auto',
    height: 'auto',
    maxWidth: '100%',
    maxHeight: '82vh',
  },
  layerOver: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  },
  pill: {
    position: 'absolute',
    left: '8px',
    bottom: '8px',
    display: 'flex',
    gap: '1px',
    borderRadius: size.radius,
    overflow: 'hidden',
    fontFamily: font.mono,
    fontSize: '12.1px',
  },
  pillHalf: {
    paddingBlock: '3px',
    paddingInline: '8px',
    backgroundColor: '#0b0d11cc',
    color: color.boneDim,
  },
  pillHalfOn: {
    backgroundColor: color.satin,
    color: '#fff',
  },
  caption: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '10px',
    marginTop: '6px',
    marginInline: 0,
    marginBottom: 0,
  },
});

const TONES = { eye: styles.eye, sensor: styles.sensor, hdr: styles.hdr, sdr: styles.sdr };
type Tone = keyof typeof TONES;

/**
 * The screens. These rows are what a reader can *see* of a file on that panel, so
 * **none of them may run past the eye row**, whatever the panel is physically capable of.
 *
 * Both HDR panels peak around 1600 nits on the small bright areas a photograph actually
 * puts there, so what separates them is the bottom.
 *
 * - **OLED**: pixels switch off, so nothing about the panel stops you. The eye does, at
 *   -14, and that is where the row ends.
 * - **XDR**: zone-dimmed, so it blooms. Its 1,000,000:1 is a full-field-black figure and
 *   describes nothing you will ever look at; with bright content on screen the local
 *   floor is nearer 0.05 nits, which is -12, not the OLED's -14.
 * - **LCD in a lit room**: ambient reflected off the glass, ~0.5 nits, which is -8.7.
 */
const XDR = HdrPageStrings.screenXdr();
const OLED = HdrPageStrings.screenOled();
const LCD = HdrPageStrings.screenLcd();

const RANGES: {
  label: string;
  low: number;
  high: number;
  tone: Tone;
  under?: { label: string; low: number; high: number }[];
}[] = [
  { label: HdrPageStrings.rangeEyes(), low: -14, high: 6, tone: 'eye' },
  { label: HdrPageStrings.rangeSensor(), low: -11, high: 3, tone: 'sensor' },
  {
    label: HdrPageStrings.rangeHdr(),
    low: -22.3,
    high: 5.6,
    tone: 'hdr',
    under: [
      { label: OLED, low: -14, high: 3 },
      { label: XDR, low: -12, high: 3 },
      { label: LCD, low: -8.7, high: 1.6 },
    ],
  },
  {
    label: HdrPageStrings.rangeJpeg(),
    low: -11.5,
    // Cameras put diffuse white near code 240, so glints keep log2(linear(255) / linear(240)).
    high: 0.2,
    tone: 'sdr',
    under: [
      // Both identical to the format bar above them, and that is the finding rather than
      // a mistake: either screen reaches past sRGB's own floor at -11.5, so what limits a
      // JPEG there is the JPEG. The HDR file is the other way round on the same two.
      { label: OLED, low: -11.5, high: 0.2 },
      { label: XDR, low: -11.5, high: 0.2 },
      { label: LCD, low: -8.5, high: 0.2 },
    ],
  },
];

const AXIS_LOW = -23;
const AXIS_HIGH = 6.5;
const TICKS = [-20, -15, -10, -5, 0, 5];

function across(stops: number): number {
  return ((stops - AXIS_LOW) / (AXIS_HIGH - AXIS_LOW)) * 100;
}

/** One labelled bar, with the stretch above white hatched over it. */
function Bar({
  label,
  low,
  high,
  tone,
  under = false,
}: {
  label: string;
  low: number;
  high: number;
  tone: Tone;
  under?: boolean;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.row, under && styles.rowUnder)}>
      <Text as="div" style={[styles.label, under && styles.labelUnder]}>
        {label}
      </Text>
      <div {...stylex.props(styles.track, under && styles.trackUnder)}>
        {TICKS.map((tick) => (
          <span
            key={tick}
            {...stylex.props(styles.tick, tick === 0 && styles.tickWhite)}
            style={{ left: `${across(tick)}%` }}
          />
        ))}
        <span
          {...stylex.props(styles.bar, TONES[tone], under && styles.barUnder)}
          style={{ left: `${across(low)}%`, width: `${across(high) - across(low)}%` }}
        />
        {/* The part above white, hatched. It is the whole argument of the page and on a
            plain bar it is just more bar. */}
        {high > 0 && (
          <span
            {...stylex.props(styles.over, under && styles.overUnder)}
            style={{ left: `${across(0)}%`, width: `${across(high) - across(0)}%` }}
          />
        )}
      </div>
      <Text variant="mono" as="div" style={styles.count}>
        {HdrPageStrings.stops(Math.round(high - low))}
      </Text>
    </div>
  );
}

function RangeChart(): JSX.Element {
  return (
    <div {...stylex.props(styles.stops)}>
      {RANGES.map((range) => (
        <Fragment key={range.label}>
          <Bar label={range.label} low={range.low} high={range.high} tone={range.tone} />
          {/* What that format is cut down to by the screen it lands on. Indented, because
              each one is a subset of the bar above rather than a fifth thing. */}
          {range.under?.map((screen) => (
            <Bar
              key={screen.label}
              label={screen.label}
              low={screen.low}
              high={screen.high}
              tone={range.tone}
              under
            />
          ))}
        </Fragment>
      ))}
      {/* A row like the others, so the labels stay under their ticks without a second
          copy of the grid's column widths to keep in step with it. */}
      <div {...stylex.props(styles.row)} aria-hidden>
        <span />
        <div {...stylex.props(styles.axis)}>
          {TICKS.map((tick) => (
            <Text
              key={tick}
              variant="mono"
              as="span"
              style={[styles.axisTick, styles.at(`${across(tick)}%`)]}
            >
              {tick === 0 ? HdrPageStrings.axisWhite() : HdrPageStrings.axisTick(tick)}
            </Text>
          ))}
        </div>
        <span />
      </div>
    </div>
  );
}

/**
 * Two versions of one thing, in the same place, swapped by pressing it.
 *
 * **Everything on this page is compared this way, including the swatches, and that is
 * not only about the eye having to travel.** A standard-range browser renders a PQ file
 * by fixing its own white at about 406 nits, measured: a patch sitting exactly on
 * diffuse white paints at 187 where an sRGB white paints 255, and it does so whatever
 * the file declares - a flat 203-nit image with nothing above white at all still comes
 * out at 187, and `clli` does not move it. So any SDR picture shown *beside* a PQ one is
 * going to make the PQ one look dim on the majority of screens, for reasons that have
 * nothing to do with what the page is arguing. In the same place, one after the other,
 * there is nothing to hold it against.
 */
function Swap({ scene, label, alt }: { scene: SceneName; label: string; alt: string }): JSX.Element {
  // Eight bits first, because that is the picture the reader already has and the page is
  // about what it costs them. Opening on the HDR one asks them to notice an absence.
  const [hdr, setHdr] = useState(false);
  return (
    <button
      type="button"
      {...stylex.props(styles.frame, focusRing.ring)}
      aria-pressed={hdr}
      aria-label={HdrPageStrings.swapLabel(label, hdr)}
      onClick={() => setHdr((was) => !was)}
    >
      <img
        src={PHOTOS[scene].sdr}
        alt={HdrPageStrings.sdrAlt(alt)}
        {...stylex.props(styles.layer, styles.layerBase, !hdr && styles.layerUp)}
      />
      <HdrPicture
        source={hdrSource(scene)}
        alt={HdrPageStrings.hdrAlt(alt)}
        style={[styles.layer, styles.layerOver, hdr && styles.layerUp]}
      />
      <span {...stylex.props(styles.pill)} aria-hidden>
        <span {...stylex.props(styles.pillHalf, !hdr && styles.pillHalfOn)}>
          {HdrPageStrings.eightBit()}
        </span>
        <span {...stylex.props(styles.pillHalf, hdr && styles.pillHalfOn)}>
          {HdrPageStrings.hdr()}
        </span>
      </span>
    </button>
  );
}

type Children = { children?: ReactNode };

/** One photograph, in both ranges. */
function Comparison({ scene, title }: { scene: SceneName; title: string }): JSX.Element {
  return (
    <figure {...stylex.props(styles.compare)}>
      <Swap scene={scene} label={title} alt={title} />
      <figcaption {...stylex.props(styles.caption)}>
        <Text variant="mono">{HdrPageStrings.clickToSwitch()}</Text>
      </figcaption>
    </figure>
  );
}

function Prose({ children }: Children): JSX.Element {
  return <div {...stylex.props(styles.text)}>{children}</div>;
}

function HdrParagraph({ children }: Children): JSX.Element {
  return (
    <Paragraph muted style={styles.p}>
      {children}
    </Paragraph>
  );
}

const InColumn = createContext(false);

function SectionHeading({ children }: Children): JSX.Element {
  const inColumn = useContext(InColumn);
  return <Heading style={inColumn ? styles.h2OpensColumn : styles.h2}>{children}</Heading>;
}

function SdrNotice({ children }: Children): JSX.Element | null {
  if (useHdrDisplay()) return null;
  return (
    <div {...stylex.props(styles.notice)}>
      <Text as="p" style={styles.p}>
        {children}
      </Text>
    </div>
  );
}

function Split({ children }: Children): JSX.Element {
  return <section {...stylex.props(styles.split)}>{children}</section>;
}

function Column({ wide = false, children }: Children & { wide?: boolean }): JSX.Element {
  return (
    <InColumn.Provider value>
      <div {...stylex.props(!wide && styles.text)}>{children}</div>
    </InColumn.Provider>
  );
}

function Note({ children }: Children): JSX.Element {
  return (
    <Text variant="mono" as="p" style={[styles.p, styles.note]}>
      <InParagraph.Provider value>{children}</InParagraph.Provider>
    </Text>
  );
}

/**
 * One PQ file holding both halves, not two files: a standard-range browser paints a PQ file
 * about a quarter dim against an sRGB one, so a pair could not be compared.
 */
function Swatches(): JSX.Element {
  return (
    <figure {...stylex.props(styles.swatches)}>
      <HdrPicture
        source={SWATCHES}
        alt={HdrPageStrings.swatchesAlt()}
        style={styles.swatchesImage}
      />
      <figcaption {...stylex.props(styles.swatchesCaption)}>
        <Text variant="mono" style={styles.swatchesHalf}>
          {HdrPageStrings.eightBit()}
        </Text>
        <Text variant="mono" style={[styles.swatchesHalf, styles.swatchesHalfRight]}>
          {HdrPageStrings.hdr()}
        </Text>
      </figcaption>
    </figure>
  );
}

function Scenes({ children }: Children): JSX.Element {
  return <div {...stylex.props(styles.scenes)}>{children}</div>;
}

/**
 * No heading per photograph: the sentence above each one already names its subject. `title`
 * is what the alt and aria text are built from.
 */
function Scene({
  scene,
  title,
  children,
}: Children & { scene: SceneName; title: string }): JSX.Element {
  return (
    <section {...stylex.props(styles.scene)}>
      <Text variant="muted" as="p" style={[styles.p, styles.pInScene]}>
        <InParagraph.Provider value>{children}</InParagraph.Provider>
      </Text>
      <Comparison scene={scene} title={title} />
    </section>
  );
}

const COPY = {
  p: HdrParagraph,
  h2: SectionHeading,
  Prose,
  SdrNotice,
  Split,
  Column,
  RangeChart,
  Note,
  Swatches,
  Scenes,
  Scene,
} satisfies MDXComponents;

export type MDXProvidedComponents = typeof COPY;

mount('hdr', <HdrPageCopy components={COPY} />);
