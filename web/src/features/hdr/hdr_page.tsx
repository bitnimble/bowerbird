import { useState } from 'react';
import { Heading } from '../../ui/heading';
import { Text } from '../../ui/text';
import { useHdrVideo } from '../photos/hdr_video';

// Why a library would be set to HDR, argued with photographs rather than adjectives.
//
// Static: nothing here reads a store or the API. The pictures are files under
// `web/public/hdr`, built by `scripts/hdr-demo-assets.ts` - one `runJob` per raw file
// with an SDR target and an HDR one, at the shipped defaults - so each pair is the same
// render encoded twice, and the page shows what an import would actually produce rather
// than a demonstration graded to win.

/**
 * How much of a scene each thing holds, in stops either side of diffuse white.
 *
 * Diffuse white is the anchor rather than black because it is what the four disagree
 * about, and because it is where photographs are lost: the JPEG's range simply stops
 * there. Approximate by nature - every figure depends on where you decide the useful
 * range ends - which the note under the chart says rather than the numbers pretending
 * otherwise.
 */
const RANGES = [
  { label: 'Your eyes, on one scene', low: -14, high: 6, tone: 'eye' },
  { label: 'A sensor, in one exposure', low: -11, high: 3, tone: 'sensor' },
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
    body: 'The obvious one. The sun, the cloud around it and every glint off the water are all brighter than the chalk cliff, and the 8-bit frame has one value - white - for all of them. Nothing in it can say that the sea was sparkling and the cliff was merely pale.',
    by: 'Popanz',
    topic: 44432,
  },
  {
    slug: 'moon',
    title: 'A moon over the roofs',
    body: 'A very bright thing occupying almost none of the frame. There is no wide sunlit area to lose here, and the point is small enough to miss: in eight bits the moon is a flat white disc, and switching puts the cloud back across its face. A picture can be nearly all shadow and still be losing something, which is why the loss goes unnoticed in this kind of frame.',
    by: 'Popanz',
    topic: 44647,
  },
  {
    slug: 'neon',
    title: 'A neon sign at night',
    body: 'The tubes are the brightest thing for a street around, and in eight bits they are white with a coloured edge - the same white as the lamp inside the doorway, and the same white as a sheet of paper would be. Nothing left in the file says which of them was a light.',
    by: 'thumper',
    topic: 55901,
  },
  {
    slug: 'sign',
    title: 'Saturated, and bright',
    body: "This is the one that surprises people. A red tube is not a dim red - it is red at a thousand nits, something like (1000, 300, 300) where white is (203, 203, 203). Eight bits has to bring that under white, and it does it a channel at a time: red hits the ceiling first, then blue, then green, and the tube's core arrives at pure white with the colour left in a ring around it. It is not that the highlight is too bright to hold. It is that clipping happens per channel, so the ratio between them - which is what colour is - goes first.",
    by: 'sushey',
    topic: 33920,
  },
  {
    slug: 'leds',
    title: 'Coloured light on things',
    body: 'The same failure one step removed. Nothing here is a light source, but the highlights on the metal are coloured light rather than white, and in eight bits the brightest of them desaturate towards white while the rest of the picture keeps its blue and red. The picture ends up looking like it was lit by two lamps and a torch.',
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
        aria-label={`${scene.title}: showing the ${hdr ? 'HDR' : '8-bit'} version. Activate to switch.`}
        onClick={() => setHdr((was) => !was)}
      >
        <img
          src={`/hdr/${scene.slug}-sdr.avif`}
          alt={`${scene.title}, as an 8-bit JPEG can hold it`}
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
        <Text variant="mono">Click or tap the picture to switch.</Text>
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
        A raw file records more of a scene than an 8-bit JPEG can carry, and nearly everything it has to throw away is above diffuse
        white - the part of a picture that is not a shade of the subject but a light in its own right. Below are five photographs
        where that costs something, each of them shown twice.
      </Text>

      {!high && (
        <div className="notice">
          <Text as="p">
            This display is reporting standard dynamic range, so the two versions of each photograph will look far more alike than
            they are - the colour losses will still show, the brightness ones will not. Firefox reports this even on an HDR display;
            Chrome and Safari answer honestly.
          </Text>
        </div>
      )}

      <Heading>What fits where</Heading>
      <Text variant="muted" as="p">
        Stops of light, measured from diffuse white: a white shirt, a sheet of paper, a sunlit cloud. Everything to the right of
        that mark was a light source rather than a lit surface, and an 8-bit JPEG has none of it.
      </Text>
      <RangeChart />
      <Text variant="mono" as="p" className="prose__note">
        Approximate, and each figure depends on where you decide the useful range ends. The eye's is one adaptation state with the
        gaze moving over a scene; given minutes to adapt it is far wider. The sensor's is a modern full-frame body at base ISO, and
        the exposure is assumed placed so a couple of stops sit above white. The HDR file is PQ mastered at 1000 nits against ITU-R
        BT.2408's 203-nit diffuse white, which is what this app encodes.
      </Text>

      <Heading>Where it shows</Heading>
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

      <Heading>What this is actually showing</Heading>
      <Text variant="muted" as="p">
        Both halves of every pair are renditions of one raw file, built in a single job by the same pipeline an import uses, at the
        settings this app ships with. They come off the same render with the same colour treatment; the only difference is that one
        was encoded into 8-bit sRGB and the other into 10-bit PQ, where there is room above white to put things.
      </Text>
      <Text variant="muted" as="p">
        A library is set to HDR in Settings. The grid stays SDR whatever the setting says - a wall of HDR tiles is punishing to look
        at - so this applies to the photo view and to exports.
      </Text>
    </div>
  );
}
