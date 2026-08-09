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
 * Approximate by nature - every figure depends on where you decide the useful range ends
 * - which the note under the chart says rather than the numbers pretending otherwise.
 */
const RANGES = [
  { label: 'Your eyes', low: -14, high: 6, tone: 'eye' },
  { label: 'A camera at one exposure', low: -11, high: 3, tone: 'sensor' },
  { label: 'A 10-bit HDR file', low: -13, high: 2.3, tone: 'hdr' },
  { label: 'An 8-bit JPEG', low: -8, high: 0, tone: 'sdr' },
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
    title: 'The obvious case',
    body: 'The foam and the brightest part of the cloud are the same white in eight bits, because that is the only white there is. Switch, and the water goes back to being lit.',
  },
  {
    slug: 'sunset',
    title: 'Where the colour goes',
    body: 'The strip above, happening to a photograph. The band of sky over the horizon was the most saturated thing here and it is the palest thing in the eight-bit file, because moving it towards white was the only way that file had to say it was bright.',
  },
  {
    slug: 'arches',
    title: 'Something that was a light',
    body: 'These arches are light sources, seven times brighter than anything eight bits is able to call white, so in the smaller file they are just pink shapes on some grass. Switch, and they start behaving like lights.',
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
      aria-label={`${label}. This is the ${hdr ? 'HDR' : 'eight-bit'} version; activate to see the other one.`}
      onClick={() => setHdr((was) => !was)}
    >
      <img
        src={`/hdr/${slug}-sdr.avif`}
        alt={`${alt}, as eight bits holds it`}
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
        Your camera keeps more of a scene than a JPEG can hold, and nearly all of what it throws away is at the bright end, where a
        picture stops being a lit surface and starts being a light. Each photograph below starts as eight bits holds it. Click one to
        see what was there.
      </Text>

      {!high && (
        <div className="notice">
          <Text as="p">
            Your display is reporting standard dynamic range, so the two versions will look closer than they are. Firefox reports
            this even on an HDR screen.
          </Text>
        </div>
      )}

      <Heading>How much of a scene fits</Heading>
      <Text variant="muted" as="p">
        Stops of light either side of white - a shirt, a sheet of paper, a sunlit cloud. Anything right of that line was a light
        source rather than something lit by one, and a JPEG holds none of it.
      </Text>
      <RangeChart />
      <Text variant="mono" as="p" className="prose__note">
        Rough figures; everyone draws the line somewhere different. Your eyes are taken glancing around one scene, the camera is a
        full-frame body at base ISO, and the HDR file assumes a 1000-nit screen.
      </Text>

      <Heading>Where the extra light goes</Heading>
      <Text variant="muted" as="p">
        The only way an eight-bit file can say something is brighter is to move it towards white, and a colour on its way to white
        gives up its colour: the channel that was already full cannot rise, so the other two catch up with it. HDR puts the light
        behind the colour instead.
      </Text>
      <Text variant="muted" as="p">
        Five colours, climbing by the same amount to the right. Same climb both sides: with a ceiling at white on the left, without
        one on the right. The left goes pale and stops. The right holds its hue and saturation exactly while the light goes up five
        times. The grey row has no colour to spend, so it just runs out.
      </Text>
      <figure className="swatches">
        <img
          src="/hdr/swatches.avif"
          alt="Five colours stepped brighter from left to right, twice: with a ceiling at white, where they pale out and stop, and without one, where they keep their colour and go on brightening"
        />
        <figcaption>
          <Text variant="mono">Eight bits</Text>
          <Text variant="mono">HDR</Text>
        </figcaption>
      </figure>

      <Heading>Where you notice it</Heading>
      {SCENES.map((scene) => (
        <section key={scene.slug} className="prose__section">
          <Text variant="label" as="div">
            {scene.title}
          </Text>
          <Text variant="muted" as="p">
            {scene.body}
          </Text>
          <Comparison scene={scene} />
        </section>
      ))}

      <Heading>About these pictures</Heading>
      <Text variant="muted" as="p">
        Each pair is one raw file developed once and saved twice, the eight-bit version being the same picture with its ceiling
        brought down to white. Nothing below white differs, so everything you see change is something the smaller file had nowhere
        to put.
      </Text>
    </div>
  );
}
