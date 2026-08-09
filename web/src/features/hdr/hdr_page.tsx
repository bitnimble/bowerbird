import { useState } from 'react';
import { Heading } from '../../ui/heading';
import { Text } from '../../ui/text';
import { useHdrVideo } from '../photos/hdr_video';

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
const RANGES = [
  { label: 'Your eyes', low: -14, high: 6, tone: 'eye' },
  { label: 'A camera at one exposure', low: -11, high: 3, tone: 'sensor' },
  { label: 'A 10-bit HDR file', low: -12, high: 2.3, tone: 'hdr' },
  { label: 'An 8-bit JPEG', low: -9.8, high: 0.2, tone: 'sdr' },
];

const AXIS_LOW = -15;
const AXIS_HIGH = 7;
const TICKS = [-15, -10, -5, 0, 5];

function across(stops: number): number {
  return ((stops - AXIS_LOW) / (AXIS_HIGH - AXIS_LOW)) * 100;
}

function RangeChart(): JSX.Element {
  return (
    <div className="stops">
      {RANGES.map((range) => (
        <div key={range.label} className="stops__row">
          <Text as="div" className="stops__label">
            {range.label}
          </Text>
          <div className="stops__track">
            {TICKS.map((tick) => (
              <span
                key={tick}
                className={`stops__tick${tick === 0 ? ' stops__tick--white' : ''}`}
                style={{ left: `${across(tick)}%` }}
              />
            ))}
            <span
              className={`stops__bar stops__bar--${range.tone}`}
              style={{ left: `${across(range.low)}%`, width: `${across(range.high) - across(range.low)}%` }}
            />
            {/* The part above white, hatched. It is the whole argument of the page and on
                a plain bar it is just more bar. */}
            {range.high > 0 && (
              <span className="stops__over" style={{ left: `${across(0)}%`, width: `${across(range.high) - across(0)}%` }} />
            )}
          </div>
          <Text variant="mono" as="div" className="stops__count">
            {Math.round(range.high - range.low)} stops
          </Text>
        </div>
      ))}
      {/* A row like the others, so the labels stay under their ticks without a second
          copy of the grid's column widths to keep in step with it. */}
      <div className="stops__row" aria-hidden>
        <span />
        <div className="stops__axis">
          {TICKS.map((tick) => (
            <Text key={tick} variant="mono" as="span" className="stops__axis-tick" style={{ left: `${across(tick)}%` }}>
              {tick === 0 ? 'white' : `${tick > 0 ? '+' : ''}${tick}`}
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

// From the losses every photographer has seen to the one nobody thinks about. The
// slugs are `scripts/hdr-demo-assets.ts`'s, which is where the raw files are named.
const SCENES: Scene[] = [
  {
    slug: 'rapids',
    title: 'Whitewater under an overcast sky',
    body: "The foam and the brightest part of the cloud come out as the same white in 8 bits, because that's the only white there is. Switch it over and the water goes back to being lit.",
  },
  {
    slug: 'sunset',
    title: 'A sunset over railway tracks',
    body: 'The band of sky over the horizon is brighter than anything else here, so 8 bits has to fold it into the top of its range. Switch it over and it just keeps going.',
  },
  {
    slug: 'arches',
    title: 'Lit arches at night',
    body: "Here's that strip again, as a photograph. Where the arches are brightest, 8 bits gives up on the colour completely: 51% of those pixels come out white instead of pink, because red hit the ceiling first and the other 2 climbed up to meet it. In HDR they stay pink the whole way through.",
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
  const hdrSrc = `/hdr/${slug}-hdr.avif`;
  // Firefox composites HDR for video and only video, so the still is rewrapped there
  // (DESIGN §10.7.2). Null everywhere else, where the `<img>` is the better element.
  const hdrVideo = useHdrVideo(hdrSrc, true);

  return (
    <button
      type="button"
      className="compare__frame"
      aria-pressed={hdr}
      aria-label={`${label}. Showing the ${hdr ? 'HDR' : '8-bit'} version. Activate to see the other one.`}
      onClick={() => setHdr((was) => !was)}
    >
      <img
        src={`/hdr/${slug}-sdr.avif`}
        alt={`${alt}, as 8 bits holds it`}
        className={`compare__layer compare__layer--base${hdr ? '' : ' is-up'}`}
      />
      {hdrVideo == null ? (
        <img src={hdrSrc} alt={`${alt}, in HDR`} className={`compare__layer compare__layer--over${hdr ? ' is-up' : ''}`} />
      ) : (
        <video src={hdrVideo} autoPlay loop muted playsInline className={`compare__layer compare__layer--over${hdr ? ' is-up' : ''}`} />
      )}
      <span className="compare__pill" aria-hidden>
        <span className={hdr ? '' : 'is-on'}>8-bit</span>
        <span className={hdr ? 'is-on' : ''}>HDR</span>
      </span>
    </button>
  );
}

/** One photograph, in both ranges. */
function Comparison({ scene }: { scene: Scene }): JSX.Element {
  return (
    <figure className="compare">
      <Swap slug={scene.slug} label={scene.title} alt={scene.title} />
      <figcaption className="compare__caption">
        <Text variant="mono">Click or tap to switch.</Text>
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
    // One element rather than a `.prose` inside a `.pad`: the collapsed rail's expand
    // button floats over the first child of `.pad`, and only a heading there leaves
    // room for it.
    <div className="pad prose">
      <Heading level={1}>What HDR is for</Heading>

      <Text variant="muted" as="p">
        The RAW photos your camera takes have more dynamic range than an 8-bit JPEG can show. That's why you can pull detail out of
        the highlights and shadows of a RAW but not a JPEG, and it's the reason we shoot RAW at all. So what if you weren't limited
        by JPEG, and could just see all that detail RAW has been hiding?
      </Text>
      <Text variant="muted" as="p">
        Each photo below starts out the way 8 bits holds it. Click one to see what was really there.
      </Text>

      {!high && (
        <div className="notice">
          <Text as="p">
            Your display is reporting standard dynamic range, so both versions will look closer than they really are. Firefox
            reports this even on an HDR screen.
          </Text>
        </div>
      )}

      <Heading>White isn't the top</Heading>
      <Text variant="muted" as="p">
        You probably picture a photo as running from 0 to 255, with black at one end and white at the other and everything sitting
        somewhere in between. That's how the file works, but it isn't how light works.
      </Text>
      <Text variant="muted" as="p">
        It helps to put white in the middle instead. Not the brightest thing imaginable, just the white of a sheet of paper in the
        same light as your subject. Almost everything you photograph is lit that way rather than lighting itself, so it lands at or
        below that mark, and that's the half we all think in. The other half is the things that make their own light: the sun, a
        lamp, a neon tube, the glint off a wave. They can be hundreds of times brighter than the paper and nothing much caps them.
      </Text>
      <Text variant="muted" as="p">
        A JPEG puts that white near the very top of what it can store and keeps about a fifth of a stop above it for the glints.
        That's its entire half.
      </Text>

      <Heading>How much of a scene fits</Heading>
      <Text variant="muted" as="p">
        Stops of light either side of white. Everything to the right of the line made its own light, and the hatched part is how
        much of it each one holds.
      </Text>
      <RangeChart />
      <Text variant="mono" as="p" className="prose__note">
        Rough figures, and the file bars are what a screen can really show rather than what the format could encode. Notice they
        aren't far apart. What changes is where they sit.
      </Text>

      <Heading>Where the extra light goes</Heading>
      <Text variant="muted" as="p">
        An 8-bit file has only one way to say that something is brighter, which is to move it towards white. So a colour gives up
        its colour on the way there: the channel that's already full can't rise any further, so the other 2 climb up to meet it. HDR
        can put the light behind the colour and leave the colour alone.
      </Text>
      <Text variant="muted" as="p">
        Both halves below hold the same 5 colours and the same climb to the right, but the left one has a ceiling at white and the
        right one doesn't. The left goes pale and stops, while the right keeps its hue and saturation exactly as the light behind it
        goes up 5 times. Watch the grey row at the bottom: it has no colour to spend, so it just runs out.
      </Text>
      <figure className="swatches">
        <img
          src="/hdr/swatches.avif"
          alt="The same 5 colours stepped brighter twice. On the left they pale out and stop at white. On the right they keep their colour and go on brightening."
        />
        <figcaption>
          <Text variant="mono">8-bit</Text>
          <Text variant="mono">HDR</Text>
        </figcaption>
      </figure>

      <Heading>Where you notice it</Heading>
      {/* No heading per photograph: with three of them the labels were repeating what the
          sentence under them already said. `title` survives for the alt and aria text. */}
      {SCENES.map((scene) => (
        <section key={scene.slug} className="prose__section">
          <Text variant="muted" as="p">
            {scene.body}
          </Text>
          <Comparison scene={scene} />
        </section>
      ))}

      <Heading>About these pictures</Heading>
      <Text variant="muted" as="p">
        Each pair is one RAW file developed once and saved twice, where the 8-bit version is the same picture with its ceiling
        brought down to white. Nothing below white differs, so everything you see change is something the smaller file had nowhere
        to put.
      </Text>
    </div>
  );
}
