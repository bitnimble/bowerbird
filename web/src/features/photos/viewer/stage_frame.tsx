import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeFrame, decodedFrame, fittedCanvasSize, type Decoded } from './stage_bitmaps';
import { CanvasLost, stageCanvases, useStageCanvas } from './stage_canvas';
import type { FileRenderingIntent } from '../../../../../src/schemas/rendering_intent';
import { stageStyles } from './photo_stage.stylex';

const styles = stylex.create({
  retiring: {
    opacity: 1,
  },
  // Keeps a hidden frame's raster, so revealing it is an opacity change with no repaint.
  layer: {
    willChange: 'opacity',
  },
});

export type FrameState = 'ready' | 'retiring' | 'layer' | null;

// One mounted frame, owning its own decode.
//
// A component per source rather than one effect over a list, because a decode is
// per element and hooks cannot be: this is what lets the stage hold two frames of
// one round, each arriving when it arrives. Keyed by source by the caller, so
// promotion keeps the element and what it decoded is what gets painted.
export function StageFrame({
  source,
  photoKey,
  hold,
  video,
  alt,
  state,
  zoomed,
  shown,
  requested,
  whole,
  proof,
  onDecoded,
  onMissing,
}: {
  source: string;
  /** Reported against, so a frame carried into a new round reports again. */
  photoKey: string;
  hold: boolean;
  video: boolean;
  alt: string;
  state: FrameState;
  zoomed: boolean;
  /** Decode every pixel of the file rather than a frame fitted to the stage (`decodeFrame`). */
  whole: boolean;
  /**
   * This is the frame on screen. Every other one is hidden from the reader: a stage holds
   * the renditions of this photograph and the neighbours either side, so half a dozen
   * elements carry the same `alt` and only one of them is a picture anybody is looking at.
   */
  shown: boolean;
  requested: boolean;
  /** The operator an HDR frame is proofed to sRGB with, or null to draw it as it is. */
  proof: FileRenderingIntent | null;
  onDecoded: (source: string, width: number, height: number) => void;
  onMissing: (source: string) => void;
}): JSX.Element {
  const elementRef = useRef<HTMLCanvasElement | HTMLVideoElement | null>(null);
  // Through refs: callers pass inline callbacks, and a new identity per render
  // would restart the decode below while one is in flight.
  const decoded = useRef(onDecoded);
  decoded.current = onDecoded;
  const missing = useRef(onMissing);
  missing.current = onMissing;
  // Through a ref too: as a dependency, every zoom in or out would redraw the whole frame.
  const wholeRef = useRef(whole);
  wholeRef.current = whole;
  const requestedRef = useRef(requested);
  requestedRef.current = requested;
  // Bumped to replace the canvas element itself, which is the only answer to one that took
  // a WebGPU context and then could not be drawn into: it can hold no other kind, so a 2D
  // draw on it is impossible and the frame would otherwise be reported as one the server
  // never had. `stage_gpu` gives the path up at the same moment, so the fresh element takes
  // the 2D route and this cannot go round twice.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const element = elementRef.current;
    if (element == null || hold) return;
    let live = true;

    const report = (width: number, height: number): void => {
      if (!live) return;
      decoded.current(source, width, height);
    };

    // A video when it has a frame to show (`loadeddata`; `loadedmetadata` knows the size and
    // nothing else). Firefox's HDR twin is the only one, and it is built in the page out of
    // a still already fetched.
    if (element instanceof HTMLVideoElement) {
      const arrived = (): void => report(element.videoWidth, element.videoHeight);
      if (element.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) arrived();
      else element.addEventListener('loadeddata', arrived);
      return () => {
        live = false;
        element.removeEventListener('loadeddata', arrived);
      };
    }

    // The frame is a bitmap this page decoded and holds (`stage_bitmaps.ts`), drawn into a
    // canvas of its own. Drawn here rather than at the reveal: the draw is what uploads the
    // texture, and doing it while the photograph is still a neighbour is what makes stepping
    // onto it an opacity change and nothing else.
    const draw = (frame: Decoded): void => {
      // Closed while its decode was in flight - the run moved on and this frame is not held
      // any more - and drawing a closed one throws.
      if (!live || frame.closed) return;
      // Reported after the draw, not beside it: the picture is up once the frame is in the
      // canvas, and everything that waits on a picture being up waits on this.
      void stageCanvases.paint(element, fittedCanvasSize(frame), frame, undefined, proof).then(
        () => {
          if (!live) return;
          // The file's own shape, not the decoded one's: what is decoded is capped at what this
          // display can show, and a reader asking a photograph's dimensions is asking about the
          // photograph.
          report(frame.naturalWidth, frame.naturalHeight);
        },
        (err: unknown) => {
          if (!live) return;
          // The element is spent rather than the picture unreadable, so what it needs is a
          // new element and not a report that the photograph is gone.
          if (err instanceof CanvasLost) {
            setAttempt((was) => was + 1);
            return;
          }
          // A frame that decoded and then could not be drawn is as blank as one that never
          // arrived, so it is reported the same way rather than left as an empty canvas the
          // stage believes in.
          missing.current(source);
        },
      );
    };

    const already = decodedFrame(source);
    if (already != null) {
      draw(already);
      return () => {
        live = false;
      };
    }

    void decodeFrame(source, wholeRef.current, requestedRef.current ? 'interactive' : 'background').then(draw, (err: unknown) => {
      // Abandoned rather than absent: the reader stepped past this photograph while it was
      // being fetched, which is not a photograph the server is missing.
      if (!live || (err instanceof Error && err.message === 'superseded')) return;
      missing.current(source);
    });
    return () => {
      live = false;
    };
    // `photoKey` and `hold`, not just `source`: a canvas is kept while its URL holds, so a
    // frame carried into the next round - which every decisive verdict does, the winner
    // keeping its slot - would otherwise never report again, and the round would show one
    // photo whichever slot was asked for. Redrawing it costs the blit and no decode.
  }, [source, photoKey, hold, attempt, proof]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handCanvas = useStageCanvas(canvasRef);
  const capture = useCallback(
    (element: HTMLCanvasElement | HTMLVideoElement | null): void => {
      elementRef.current = element;
      handCanvas(element instanceof HTMLVideoElement ? null : element);
    },
    [handCanvas],
  );

  const styled = stylex.props(
    stageStyles.content,
    zoomed && stageStyles.zoomed,
    state === 'ready' && stageStyles.ready,
    state === 'retiring' && styles.retiring,
    state === 'layer' && styles.layer,
  );

  if (video) {
    return (
      <video
        ref={capture}
        src={source}
        autoPlay
        loop
        muted
        playsInline
        {...styled}
        aria-hidden={!shown}
        onError={() => missing.current(source)}
      />
    );
  }
  // A canvas rather than an `<img>`, because the picture is a bitmap this page decoded and
  // holds: the browser neither chooses when to decode it nor drops it once it has. `role`
  // and `aria-label` because a canvas has no `alt`, and this one is a photograph.
  return (
    <canvas
      key={attempt}
      ref={capture}
      role="img"
      aria-label={alt}
      {...styled}
      aria-hidden={!shown}
    />
  );
}
