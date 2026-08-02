import { useEffect, useRef, useState } from 'react';
import { Button } from '../../ui/button';
import { Text } from '../../ui/text';
import { prefersStill, RawEditPipeline, supportsTenBit, type PipelineState } from './raw_edit_pipeline';

// Does a Lightroom exposure slider work in a browser, in HDR? Everything below the fetch
// runs client side: rawshim decodes the CR3 in wasm through LibRaw, fits the camera match
// from the embedded preview, grades a smaller prepared frame during a drag, and settles
// at full resolution - no encoder anywhere in the loop.
//
// **Two ways out, because one browser each can take one.** Chromium accepts a 10-bit
// `VideoFrame` and composites a PQ track, so it gets a live `<video>`. WebKit validates
// only 8-bit formats, and an 8-bit sample buffer does not reach EDR, so the same tagging
// produces a tone-mapped, washed-out picture there; Safari 26 does read CICP off a still,
// so it gets a 16-bit PQ PNG in an `<img>` instead. The route is picked from the same
// measurement, and can be forced either way to compare them on one machine.
//
// Only meaningful on an HDR display, and the patch strip is what makes it judgeable.

const DEFAULT_PATH = '/photos/Nick/IMG_7988.CR3';

// Longest edge the decode is fitted to. The grade's cost is linear in pixels and the
// grade is what a slider tick pays for, so this is the latency knob - and LibRaw halves
// the decode itself when the target is small enough, so it is a decode saving too.
const SIZES = [
  { block: 3840, label: '3840px' },
  { block: 1920, label: '1920px' },
  { block: 1280, label: '1280px' },
];

const EV_RANGE = 5;

const SINKS = [
  { still: false, label: 'video track' },
  { still: true, label: 'still PNG' },
];

export function RawEditPage(): JSX.Element {
  const video = useRef<HTMLVideoElement>(null);
  const pipeline = useRef<RawEditPipeline | null>(null);
  const [state, setState] = useState<PipelineState | null>(null);
  const [path, setPath] = useState(DEFAULT_PATH);
  const [block, setBlock] = useState(3840);
  const [still, setStill] = useState(prefersStill);
  const [ev, setEv] = useState(0);

  // Read by the effect below without being one of its dependencies: typing in the path
  // field must not tear down the pipeline and restart a decode on every keystroke. The
  // Open button is what commits an edited path.
  const pending = useRef(path);
  pending.current = path;

  // Rebuilt per size and per route, since both are fixed at decode: a new size is a new
  // decode, and therefore a new track for the element to take. Opens straight away, so
  // the page arrives showing a photograph rather than an empty stage.
  useEffect(() => {
    // Attached on arrival rather than at construction: Chromium's generator exists
    // immediately, Safari's is built worker-side and its track comes back by transfer.
    const built = new RawEditPipeline(
      setState,
      (track) => {
        if (video.current != null) video.current.srcObject = new MediaStream([track]);
      },
      still,
    );
    pipeline.current = built;
    setEv(0);
    void built.open(pending.current, block);
    return () => {
      built.close();
      pipeline.current = null;
    };
  }, [block, still]);

  function open(): void {
    setEv(0);
    void pipeline.current?.open(path, block);
  }

  function adjust(next: number): void {
    setEv(next);
    pipeline.current?.previewExposure(next);
  }

  function settle(next: number): void {
    pipeline.current?.settleExposure(next);
  }

  const hdr = matchMedia('(dynamic-range: high)').matches;
  const live = state?.status === 'live';
  const tenBit = supportsTenBit();

  return (
    <div className="raw-edit">
      <div className="raw-edit__controls">
        <input
          className="raw-edit__path"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          spellCheck={false}
          aria-label="RAW file path"
        />
        <select value={block} onChange={(e) => setBlock(Number(e.target.value))} aria-label="Working size">
          {SIZES.map((size) => (
            <option key={size.block} value={size.block}>
              {size.label}
            </option>
          ))}
        </select>
        <select
          value={String(still)}
          onChange={(e) => setStill(e.target.value === 'true')}
          aria-label="Output route"
        >
          {SINKS.map((sink) => (
            <option key={sink.label} value={String(sink.still)}>
              {sink.label}
            </option>
          ))}
        </select>
        <Button onClick={open}>Open</Button>
      </div>

      {still ? (
        <img className="raw-edit__stage" src={state?.stillUrl} alt="" />
      ) : (
        /* Muted and autoplay, because a track with no audio still needs the gesture
           policy satisfied before it will render. */
        <video ref={video} className="raw-edit__stage" autoPlay muted playsInline />
      )}

      {/* The instrument. Script cannot read back whether a frame reached the HDR
          compositor, so the only way to answer that is to put a PQ patch next to
          something that is definitionally not HDR and look. Left is BT.2408 diffuse
          white, middle is the 1000-nit display peak, right is ordinary SDR white. On a
          working path the middle patch is obviously the brightest of the three; where
          the tag has been defeated all three sit within a few percent. */}
      <div className="raw-edit__reference">
        {state != null && state.referenceUrl !== '' && (
          <img src={state.referenceUrl} alt="203 and 1000 nit PQ reference patches" />
        )}
        <div className="raw-edit__reference-sdr" />
      </div>

      <div className="raw-edit__slider">
        <label htmlFor="exposure">
          <Text variant="label" as="span">
            Exposure {ev > 0 ? '+' : ''}
            {ev.toFixed(2)} EV
          </Text>
        </label>
        <input
          id="exposure"
          type="range"
          min={-EV_RANGE}
          max={EV_RANGE}
          step={0.01}
          value={ev}
          disabled={!live}
          onChange={(e) => adjust(Number(e.target.value))}
          onBlur={(e) => settle(Number(e.currentTarget.value))}
          onKeyUp={(e) => settle(Number(e.currentTarget.value))}
          onPointerCancel={(e) => settle(Number(e.currentTarget.value))}
          onPointerUp={(e) => settle(Number(e.currentTarget.value))}
        />
      </div>

      <dl className="meta raw-edit__readout">
        <dt>Status</dt>
        <dd>{state == null ? 'idle' : (state.message !== '' ? `${state.status} - ${state.message}` : state.status)}</dd>
        <dt>Frame</dt>
        <dd>{live ? `${state.width}x${state.height}` : '-'}</dd>
        <dt>Decode</dt>
        <dd>{live ? `${state.decodeMs}ms` : '-'}</dd>
        <dt>Grade</dt>
        <dd>{live ? `${state.gradeMs}ms` : '-'}</dd>
        <dt>Delivered</dt>
        <dd>{live && state.fps > 0 ? `${state.fps}fps` : '-'}</dd>
        <dt>Threads</dt>
        <dd data-testid="raw-edit-threads">{state?.threads ?? 0}</dd>
        {/* Both depths are PQ. Safari and Firefox reject every 10-bit format, and the
            8-bit path is a coarser HDR picture rather than an SDR one - measured on an
            XDR panel, a 1000-nit patch reads clearly brighter than a 203-nit one. The
            grade dithers at 8 bits to keep PQ's toe from banding the shadows. */}
        {/* Without a match the grade takes its neutral arm - LibRaw's flat linear with a
            scale on it - which reads several stops brighter through the upper range than
            the camera's own shoulder does. */}
        <dt>Colour</dt>
        <dd>{live ? (state.matched ? 'camera match' : 'neutral (no match fitted)') : '-'}</dd>
        {/* The still is the better frame - 16 bits where a track tops out at 10, and no
            dither - and the worse drag: measured here at 9fps against 12, and 1.4GB
            resident against 841MB, for a PNG encode and decode on every tick. */}
        <dt>Output</dt>
        <dd>
          {still
            ? '16-bit PQ PNG in an <img>, 4:4:4'
            : `${tenBit ? '10-bit' : '8-bit, dithered'} PQ video track, 4:4:4`}
        </dd>
        {/* The one thing the page cannot answer for itself: HDR output is not readable
            from script, so all a machine without an HDR panel can confirm is that the
            frames carry the right signalling. */}
        <dt>Display</dt>
        <dd>{hdr ? 'HDR (dynamic-range: high)' : 'SDR - HDR output cannot be judged here'}</dd>
      </dl>
    </div>
  );
}
