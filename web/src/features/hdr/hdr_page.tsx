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
  /** The photographer, and the Play Raw thread their raw file came from. */
  by: string;
  topic: number;
}

// From the losses every photographer has seen to the one nobody thinks about. The
// slugs are `scripts/hdr-demo-assets.ts`'s, which is where the raw files are named.
const SCENES: Scene[] = [
  {
    slug: 'beach',
    title: 'The sun in the frame',
    body: 'This is the obvious case. The sun, the cloud around it and every glint off the water are all brighter than the chalk cliff, and the JPEG has only one value to give all of them. Switch it over and the sea goes back to sparkling.',
    by: 'Popanz',
    topic: 44432,
  },
  {
    slug: 'moon',
    title: 'A moon over the roofs',
    body: 'Almost the whole frame is dark, so it looks as though there is nothing here to lose. In eight bits, though, the moon is a flat white disc, and switching over puts the cloud back across its face.',
    by: 'Popanz',
    topic: 44647,
  },
  {
    slug: 'neon',
    title: 'A neon sign',
    body: 'The tubes are the brightest thing for a street around, but in eight bits they come out white with a coloured edge. That is the same white as the lamp in the doorway, and the same white as a sheet of paper would be, so nothing left in the file tells you which of them was actually a light.',
    by: 'thumper',
    topic: 55901,
  },
  {
    slug: 'sign',
    title: 'A colour that is also a light',
    body: 'This is the case that catches people out. A red neon tube is not a dim red; it is red at several stops above white. All three channels share the same ceiling, so red reaches it first, then blue, then green, and the core of the tube ends up pure white with its colour squeezed into a ring around it. The problem is not that the highlight is too bright to keep. It is that the channels clip one at a time, and the ratio between them is what colour actually is.',
    by: 'sushey',
    topic: 33920,
  },
  {
    slug: 'leds',
    title: 'Coloured light on things',
    body: 'This is the same problem as above, one step removed. Nothing in the frame is a light source, but the highlights on the metal are coloured light rather than white, and in eight bits the brightest of them wash out while the rest of the picture keeps its blue and red.',
    by: 'ilia3101',
    topic: 28404,
  },
];

/**
 * One photograph, in both ranges, in the same place on the page.
 *
 * Both are mounted and both decode up front. Side by side, the eye has to travel and
 * the difference gets argued about; in one place it is simply visible.
 */
function Comparison({ scene }: { scene: Scene }): JSX.Element {
  const [hdr, setHdr] = useState(true);
  const hdrSrc = `/hdr/${scene.slug}-hdr.avif`;
  // Firefox composites HDR for video and only video, so the still is rewrapped there
  // (DESIGN §10.7.2). Null everywhere else, where the `<img>` is the better element.
  const hdrVideo = useHdrVideo(hdrSrc, true);

  return (
    <figure className="compare">
      <button
        type="button"
        className="compare__frame"
        aria-pressed={hdr}
        aria-label={`${scene.title}. This is the ${hdr ? 'HDR' : 'eight-bit'} version; activate to see the other one.`}
        onClick={() => setHdr((was) => !was)}
      >
        <img
          src={`/hdr/${scene.slug}-sdr.avif`}
          alt={`${scene.title}, as an eight-bit JPEG holds it`}
          className={`compare__layer compare__layer--base${hdr ? '' : ' is-up'}`}
        />
        {hdrVideo == null ? (
          <img src={hdrSrc} alt={`${scene.title}, in HDR`} className={`compare__layer compare__layer--over${hdr ? ' is-up' : ''}`} />
        ) : (
          <video
            src={hdrVideo}
            autoPlay
            loop
            muted
            playsInline
            className={`compare__layer compare__layer--over${hdr ? ' is-up' : ''}`}
          />
        )}
        <span className="compare__pill" aria-hidden>
          <span className={hdr ? '' : 'is-on'}>8-bit</span>
          <span className={hdr ? 'is-on' : ''}>HDR</span>
        </span>
      </button>
      <figcaption className="compare__caption">
        <Text variant="mono">Click or tap to switch.</Text>
        <Text variant="mono">
          <a href={`https://discuss.pixls.us/t/${scene.topic}`} target="_blank" rel="noreferrer">
            Raw file
          </a>{' '}
          by {scene.by}, CC BY-SA
        </Text>
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
        Your camera keeps far more of a scene than a JPEG can hold, and nearly all of what gets thrown away is at the bright end,
        where a picture stops being a lit surface and starts being a light. Below are five photographs where that costs something.
        Each one is shown twice, and you can click it to switch between the two.
      </Text>

      {!high && (
        <div className="notice">
          <Text as="p">
            Your display is reporting standard dynamic range, so the two versions of each photograph will look much closer than they
            really are. You will still see the differences in colour, but not the ones in brightness. Firefox reports this even when
            the screen is an HDR one.
          </Text>
        </div>
      )}

      <Heading>How much of a scene fits</Heading>
      <Text variant="muted" as="p">
        The scale below is in stops, measured either side of white - the white of a shirt, a sheet of paper, or a sunlit cloud.
        Anything to the right of that line was a light source rather than something lit by one, and a JPEG holds none of it.
      </Text>
      <RangeChart />
      <Text variant="mono" as="p" className="prose__note">
        These are rough figures, because everyone draws the line somewhere slightly different. The figure for your eyes assumes you
        are glancing around a single scene; give them a few minutes to adjust in the dark and the range gets much wider. The camera
        is a modern full-frame body at its base ISO, and the HDR file assumes you are looking at a 1000-nit screen.
      </Text>

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
        Each pair is a single raw file developed twice with the same settings both times: the same exposure, the same colour, the
        same everything. The only difference between them is what the result was saved as, either eight bits or HDR with room left
        above white.
      </Text>
    </div>
  );
}
