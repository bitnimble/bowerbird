import * as stylex from '@stylexjs/stylex';
import { Fragment, useState } from 'react';
import { PathSegment, route } from '../../../../src/schemas/route';
import { focusRing } from '../../ui/focus_ring';
import { Heading } from '../../ui/heading';
import { Page, PageLead } from '../../ui/page';
import { Text } from '../../ui/text';
import { color, font, size } from '../../ui/tokens.stylex';
import { useHdrVideo } from '../photos/viewer/hdr_video';
import { HdrPageStrings } from './hdr_page.strings';

const NARROW = '@media (max-width: 640px)';
// Wide enough that the chart still has a track after the sidebar, the prose column and its own
// 190px of labels: at 1200 that leaves under 300px to draw 30 stops on.
const SPLIT = '@media (min-width: 1400px)';

const styles = stylex.create({
  at: (left: string) => ({ left }),

  // Left-aligned, not centred: `PageLead` reserves a control-wide gap before the heading only,
  // and a centred column would indent the heading against the paragraph under it.
  page: {
    maxWidth: '1480px',
    paddingBottom: '40px',
  },
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
    fontSize: '13px',
  },
  labelUnder: {
    paddingLeft: '14px',
    fontSize: '12px',
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
    backgroundImage: 'repeating-linear-gradient(-45deg, rgba(11, 13, 17, 0.55) 0 2px, transparent 2px 5px)',
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
    fontSize: '11px',
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

// What HDR buys a photographer, argued with photographs rather than adjectives.
//
// Written for someone who shoots rather than someone who encodes: it may spend stops,
// clipping and channels, and it may not spend PQ, transfer curves or nits. Nothing on
// it is about this app either - a reader who has never heard of it should get the whole
// argument - which is why the last section says what the pairs are without saying what
// made them.
//
// Static: nothing here reads a store or the API. The pictures are files under
// `web/public/hdr`, built by `scripts/hdr-demo-assets.ts` - one job per raw file with an
// SDR target and an HDR one, at the shipped defaults - so each pair is one render
// encoded twice rather than a demonstration graded to win.

/**
 * How much of a scene each thing holds, in stops either side of white.
 *
 * White is the anchor rather than black because it is what the four disagree about, and
 * because it is where photographs are lost: the JPEG's range simply stops there.
 *
 * **The two file bars are what the hardware in front of you can show**, because that and
 * not the encoding is what limits either of them. A typical SDR monitor is about 1000:1,
 * so a JPEG gets 10 stops. A good HDR display does 1000 nits over a black near 0.05, so
 * 14.3 - an OLED in a dark room stretches that towards 17.6, and an LCD in a bright one
 * falls well short of it.
 *
 * Two earlier sourcings were wrong in opposite directions and are worth not repeating.
 * Quoting each format's own specification gave 6.3 stops for sRGB (its reference *viewing
 * environment*, 80 cd/m² over 1.0) and 17.6 for HDR10 (its mastering reference): the first
 * describes a 1999 CRT in a lit office and no panel anyone owns, and the second is a
 * dark-room best case. Measuring the code values instead made the threshold the author's
 * choice - 5% gives 6.0 and 14.6, 2% gives 2.8 and 10.3, and 1%, about the Weber limit,
 * gives 0.4 and 3.9. That last pair is true and useless on a chart, since a photograph is
 * not a smooth gradient and its own grain dithers away the banding being hunted.
 *
 * What the numbers keep saying through all of that is worth reading off the chart rather
 * than out of the totals: the two formats are not far apart in *how many* stops they
 * carry. The JPEG's are all underneath white and the HDR file's are not.
 *
 * The other two bars are approximations: a full-frame sensor measures around 14 stops of
 * engineering dynamic range at base ISO, placed as though the exposure left 3 stops above
 * diffuse white, and the eye manages about 20 across one scene as the gaze moves.
 *
 * **The JPEG's headroom is 0.2 stops rather than none**, which is worth being right about
 * because the page keeps saying a JPEG has nothing above white. It nearly does. A camera
 * puts diffuse white around code 240 and not 255, so a specular glint has the last 15
 * codes to live in: `log2(linear(255) / linear(240))` is 0.20. Place white at 235 and it
 * is 0.27, at 245 and it is 0.13. So the bar goes a whisker past the line rather than
 * stopping dead on it, and 0.2 against the HDR file's 2.3 makes the point better than
 * zero would - a JPEG does reserve room for highlights, and there is almost none of it.
 */
/**
 * The screens. These rows are what a reader can *see* of a file on that panel, so
 * **none of them may run past the eye row**, whatever the panel is physically capable of.
 * A bar claiming 25 stops of visible range under a 20-stop pair of eyes is nonsense, and
 * two earlier versions of these rows did exactly that.
 *
 * Both HDR panels peak around 1600 nits on the small bright areas a photograph actually
 * puts there, so what separates them is the bottom.
 *
 * - **OLED**: pixels switch off, so nothing about the panel stops you. The eye does, at
 *   -14, and that is where the row ends.
 * - **XDR**: zone-dimmed, so it blooms. Its 1,000,000:1 is a full-field-black figure and
 *   describes nothing you will ever look at; with bright content on screen the local
 *   floor is nearer 0.05 nits, which is -12. Believing the spec sheet puts it at -14 and
 *   draws it identical to the OLED, which was the previous mistake.
 * - **LCD in a lit room**: ambient reflected off the glass, ~0.5 nits, which is -8.7.
 */
const XDR = HdrPageStrings.screenXdr();
const OLED = HdrPageStrings.screenOled();
const LCD = HdrPageStrings.screenLcd();

const RANGES: { label: string; low: number; high: number; tone: Tone; under?: { label: string; low: number; high: number }[] }[] = [
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
function Bar({ label, low, high, tone, under = false }: { label: string; low: number; high: number; tone: Tone; under?: boolean }): JSX.Element {
  return (
    <div {...stylex.props(styles.row, under && styles.rowUnder)}>
      <Text as="div" style={[styles.label, under && styles.labelUnder]}>
        {label}
      </Text>
      <div {...stylex.props(styles.track, under && styles.trackUnder)}>
        {TICKS.map((tick) => (
          <span key={tick} {...stylex.props(styles.tick, tick === 0 && styles.tickWhite)} style={{ left: `${across(tick)}%` }} />
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
            <Bar key={screen.label} label={screen.label} low={screen.low} high={screen.high} tone={range.tone} under />
          ))}
        </Fragment>
      ))}
      {/* A row like the others, so the labels stay under their ticks without a second
          copy of the grid's column widths to keep in step with it. */}
      <div {...stylex.props(styles.row)} aria-hidden>
        <span />
        <div {...stylex.props(styles.axis)}>
          {TICKS.map((tick) => (
            <Text key={tick} variant="mono" as="span" style={[styles.axisTick, styles.at(`${across(tick)}%`)]}>
              {tick === 0 ? HdrPageStrings.axisWhite() : HdrPageStrings.axisTick(tick)}
            </Text>
          ))}
        </div>
        <span />
      </div>
    </div>
  );
}

interface Scene {
  /** Names the two files under `web/public/hdr`, and the scene in the asset script. */
  slug: string;
  title: string;
  /** What to look at, and what the 8-bit frame had to do to it. */
  body: string;
}

// From the losses every photographer has seen to the one nobody thinks about: white
// detail, then a highlight nothing can hold, then a colour going white, then a colour
// eight bits has no way to say at all. The slugs are `scripts/hdr-demo-assets.ts`'s,
// which is where the raw files are named.
const SCENES: Scene[] = [
  {
    slug: 'whites',
    title: HdrPageStrings.sceneWhitesTitle(),
    body: HdrPageStrings.sceneWhitesBody(),
  },
  {
    slug: 'sun',
    title: HdrPageStrings.sceneSunTitle(),
    body: HdrPageStrings.sceneSunBody(),
  },
  {
    slug: 'saturated',
    title: HdrPageStrings.sceneSaturatedTitle(),
    body: HdrPageStrings.sceneSaturatedBody(),
  },
  {
    slug: 'gamut',
    title: HdrPageStrings.sceneGamutTitle(),
    body: HdrPageStrings.sceneGamutBody(),
  },
];

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
function Swap({ slug, label, alt }: { slug: string; label: string; alt: string }): JSX.Element {
  // Eight bits first, because that is the picture the reader already has and the page is
  // about what it costs them. Opening on the HDR one asks them to notice an absence.
  const [hdr, setHdr] = useState(false);
  const hdrSrc = route(PathSegment.hdr(), `${slug}-hdr.avif`);
  // Firefox composites HDR for video and only video, so the still is rewrapped there
  // (DESIGN §10.7.2). Null everywhere else, where the `<img>` is the better element.
  const hdrVideo = useHdrVideo(slug, hdrSrc, true);

  return (
    <button
      type="button"
      {...stylex.props(styles.frame, focusRing.ring)}
      aria-pressed={hdr}
      aria-label={HdrPageStrings.swapLabel(label, hdr)}
      onClick={() => setHdr((was) => !was)}
    >
      <img
        src={route(PathSegment.hdr(), `${slug}-sdr.avif`)}
        alt={HdrPageStrings.sdrAlt(alt)}
        {...stylex.props(styles.layer, styles.layerBase, !hdr && styles.layerUp)}
      />
      {hdrVideo == null ? (
        <img src={hdrSrc} alt={HdrPageStrings.hdrAlt(alt)} {...stylex.props(styles.layer, styles.layerOver, hdr && styles.layerUp)} />
      ) : (
        <video
          src={hdrVideo.url}
          autoPlay
          loop
          muted
          playsInline
          {...stylex.props(styles.layer, styles.layerOver, hdr && styles.layerUp)}
        />
      )}
      <span {...stylex.props(styles.pill)} aria-hidden>
        <span {...stylex.props(styles.pillHalf, !hdr && styles.pillHalfOn)}>{HdrPageStrings.eightBit()}</span>
        <span {...stylex.props(styles.pillHalf, hdr && styles.pillHalfOn)}>{HdrPageStrings.hdr()}</span>
      </span>
    </button>
  );
}

/** One photograph, in both ranges. */
function Comparison({ scene }: { scene: Scene }): JSX.Element {
  return (
    <figure {...stylex.props(styles.compare)}>
      <Swap slug={scene.slug} label={scene.title} alt={scene.title} />
      <figcaption {...stylex.props(styles.caption)}>
        <Text variant="mono">{HdrPageStrings.clickToSwitch()}</Text>
      </figcaption>
    </figure>
  );
}

/**
 * Whether this display has been told to expect more than SDR.
 *
 * Worth saying out loud, because without it the page is two identical pictures and
 * nothing on screen would explain why. It is not a reliable "no": Firefox answers
 * `standard` on an HDR display, which is why the copy hedges rather than hiding
 * anything. Read once, like the same query on the settings page: a display that
 * changes under a live window is not worth a listener here.
 */
function displayIsHdr(): boolean {
  return window.matchMedia != null && window.matchMedia('(dynamic-range: high)').matches;
}

export function HdrPage(): JSX.Element {
  const high = displayIsHdr();

  return (
    // The page itself carries the prose styles rather than a wrapper inside it: the collapsed
    // sidebar's expand button floats over the page's first row, and only a heading there leaves
    // room for it.
    <Page style={styles.page}>
      <Heading level={1}>
        <PageLead />
        {HdrPageStrings.title()}
      </Heading>

      <div {...stylex.props(styles.text)}>
        <Text variant="muted" as="p" style={styles.p}>
          {HdrPageStrings.intro()}
        </Text>
        <Text variant="muted" as="p" style={styles.p}>
          {HdrPageStrings.introHowToUse()}
        </Text>

        {!high && (
          <div {...stylex.props(styles.notice)}>
            <Text as="p" style={styles.p}>
              {HdrPageStrings.sdrNotice()}
            </Text>
          </div>
        )}
      </div>

      <section {...stylex.props(styles.split)}>
        <div {...stylex.props(styles.text)}>
          <Heading style={styles.h2OpensColumn}>{HdrPageStrings.whiteHeading()}</Heading>
          <Text variant="muted" as="p" style={styles.p}>
            {HdrPageStrings.whiteBody1()}
          </Text>
          <Text variant="muted" as="p" style={styles.p}>
            {HdrPageStrings.whiteBody2()}
          </Text>
          <Text variant="muted" as="p" style={styles.p}>
            {HdrPageStrings.whiteBody3()}
          </Text>
        </div>
        <div>
          <Heading style={styles.h2OpensColumn}>{HdrPageStrings.fitHeading()}</Heading>
          <Text variant="muted" as="p" style={styles.p}>
            {HdrPageStrings.fitBody()}
          </Text>
          <RangeChart />
          <Text variant="mono" as="p" style={[styles.p, styles.note]}>
            {HdrPageStrings.fitNote()}
          </Text>
        </div>
      </section>

      <section {...stylex.props(styles.split)}>
        <div {...stylex.props(styles.text)}>
          <Heading style={styles.h2OpensColumn}>{HdrPageStrings.colourHeading()}</Heading>
          <Text variant="muted" as="p" style={styles.p}>
            {HdrPageStrings.colourBody1()}
          </Text>
          <Text variant="muted" as="p" style={styles.p}>
            {HdrPageStrings.colourBody2()}
          </Text>
          <Text variant="muted" as="p" style={styles.p}>
            {HdrPageStrings.colourBody3()}
          </Text>
        </div>
        {/* One PQ file holding both halves, not two files: a standard-range browser paints a PQ
            file about a quarter dim against an sRGB one, so a pair could not be compared. */}
        <figure {...stylex.props(styles.swatches)}>
          <img
            src={route(PathSegment.hdr(), 'swatches.avif')}
            alt={HdrPageStrings.swatchesAlt()}
            {...stylex.props(styles.swatchesImage)}
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
      </section>

      <Heading style={styles.h2}>{HdrPageStrings.examplesHeading()}</Heading>
      {/* No heading per photograph: the sentence above each one already names its subject.
          `title` is what the alt and aria text are built from. */}
      <div {...stylex.props(styles.scenes)}>
        {SCENES.map((scene) => (
          <section key={scene.slug} {...stylex.props(styles.scene)}>
            <Text variant="muted" as="p" style={[styles.p, styles.pInScene]}>
              {scene.body}
            </Text>
            <Comparison scene={scene} />
          </section>
        ))}
      </div>

      <Heading style={styles.h2}>{HdrPageStrings.aboutHeading()}</Heading>
      <Text variant="muted" as="p" style={[styles.p, styles.text]}>
        {HdrPageStrings.aboutBody()}
      </Text>
    </Page>
  );
}
