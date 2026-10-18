import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { renditionsApi } from '../../../api/renditions';
import { shellStage } from '../../../api/transport';
import { useHdrPicture } from '../../../avif/hdr_picture';
import {
  CannotDrawHere,
  decodeFrame,
  decodedFrame,
  fittedCanvasSize,
  type Decoded,
} from './stage_bitmaps';
import { CanvasLost, stageCanvases, useStageCanvas } from './stage_canvas';
import type { RenderingIntent } from '../../../../../src/schemas/rendering_intent';
import { stageStyles } from './photo_stage.stylex';

const styles = stylex.create({
  retiring: {
    opacity: 1,
  },
  // Keeps a hidden frame's raster, so revealing it is an opacity change with no repaint.
  layer: {
    willChange: 'opacity',
  },
  hidden: {
    opacity: 0,
    pointerEvents: 'none',
  },
});

export type FrameState = 'ready' | 'retiring' | 'layer' | null;

interface Painting {
  element: HTMLCanvasElement;
  frame: Decoded;
  proof: RenderingIntent | null;
  devicePeakNits: number | null;
  done: Promise<void>;
}

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
  alt,
  state,
  zoomed,
  shown,
  requested,
  whole,
  proof,
  devicePeakNits,
  shell,
  onRefused,
  onDrawn,
  onDecoded,
  onMissing,
  onVideo,
}: {
  source: string;
  /** Reported against, so a frame carried into a new round reports again. */
  photoKey: string;
  hold: boolean;
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
  proof: RenderingIntent | null;
  devicePeakNits: number | null;
  /**
   * Prepared on the shell, which draws it behind the page (`shellDrawsStage`), rather than decoded
   * here. `onDecoded` then means the shell holds it.
   */
  shell: boolean;
  /** The shell would not draw it, so this frame has to be decoded here after all. */
  onRefused: (source: string) => void;
  /** Whether this page's canvas shows the frame. */
  onDrawn: (source: string, drawn: boolean) => void;
  onDecoded: (source: string, width: number, height: number, hdr: boolean) => void;
  /** `cannotDraw`: the file is there, and this browser cannot decode or draw it. */
  onMissing: (source: string, cannotDraw: boolean) => void;
  /** Whether this frame is up as a video (`HdrPictures`), which has no detail layer to wait on. */
  onVideo: (source: string, video: boolean) => void;
}): JSX.Element {
  const { shown: picture, failed: videoFailed } = useHdrPicture(renditionsApi.hdrSource(source), {
    activity: requested ? 'interactive' : 'background',
  });
  const video = picture?.kind === 'video' ? picture.url : null;
  const waiting = picture == null && proof == null;
  // A proof is drawn by the canvas's shader, which a `<video>` never passes through.
  const fromVideo = video != null && proof == null;
  // Kept once drawn, so turning a proof on and off is a change of which element is on top.
  const [canvasDrawn, setCanvasDrawn] = useState(false);
  const videoUp = video != null && (proof == null || !canvasDrawn);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handCanvas = useStageCanvas(canvasRef);
  const videoReport = useRef(onVideo);
  videoReport.current = onVideo;
  useEffect(() => {
    videoReport.current(source, videoUp);
    return () => videoReport.current(source, false);
  }, [source, videoUp]);
  const drawnReport = useRef(onDrawn);
  drawnReport.current = onDrawn;
  const drawnOnPage = canvasDrawn && !shell;
  useEffect(() => {
    drawnReport.current(source, drawnOnPage);
    return () => drawnReport.current(source, false);
  }, [source, drawnOnPage]);
  // Through refs: callers pass inline callbacks, and a new identity per render
  // would restart the decode below while one is in flight.
  const decoded = useRef(onDecoded);
  decoded.current = onDecoded;
  const missing = useRef(onMissing);
  missing.current = onMissing;
  const refused = useRef(onRefused);
  refused.current = onRefused;
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
  const painting = useRef<Painting | null>(null);

  useEffect(() => {
    if (!shell || hold || waiting) return;
    let live = true;
    shellStage.prepare(source, requested).then(
      (prepared) => {
        if (!live) return;
        // Only ever HDR: the shell refuses anything but PQ.
        if (prepared.state === 'ready')
          decoded.current(source, prepared.width, prepared.height, true);
        else if (prepared.state === 'missing') missing.current(source, false);
        else refused.current(source);
      },
      () => {
        if (live) refused.current(source);
      },
    );
    return () => {
      live = false;
      shellStage.release(source).catch(() => undefined);
    };
    // `requested`: a neighbour stepped onto jumps the shell's queue.
  }, [source, photoKey, hold, waiting, shell, requested]);

  useEffect(() => {
    if (shell || hold || waiting) return;
    let live = true;

    const report = (width: number, height: number, hdr: boolean): void => {
      if (!live) return;
      decoded.current(source, width, height, hdr);
    };

    // A video when it has a frame to show (`loadeddata`; `loadedmetadata` knows the size and
    // nothing else).
    const playing = videoRef.current;
    if (fromVideo && playing != null) {
      // `HdrPictures` makes a video only of a still with HDR in it.
      const arrived = (): void => report(playing.videoWidth, playing.videoHeight, true);
      if (playing.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) arrived();
      else playing.addEventListener('loadeddata', arrived);
      return () => {
        live = false;
        playing.removeEventListener('loadeddata', arrived);
      };
    }
    const element = canvasRef.current;
    if (element == null) return;

    // The frame is a bitmap this page decoded and holds (`stage_bitmaps.ts`), drawn into a
    // canvas of its own. Drawn here rather than at the reveal: the draw is what uploads the
    // texture, and doing it while the photograph is still a neighbour is what makes stepping
    // onto it an opacity change and nothing else.
    const draw = (frame: Decoded): void => {
      // Closed while its decode was in flight - the run moved on and this frame is not held
      // any more - and drawing a closed one throws.
      if (!live || frame.closed) return;
      const was = painting.current;
      const holds =
        was != null &&
        was.element === element &&
        was.frame === frame &&
        was.proof === proof &&
        was.devicePeakNits === devicePeakNits;
      const done = holds
        ? was.done
        : stageCanvases.paint(element, fittedCanvasSize(frame), frame, { devicePeakNits, proof });
      if (!holds) painting.current = { element, frame, proof, devicePeakNits, done };
      // Reported after the draw, not beside it: the picture is up once the frame is in the
      // canvas, and everything that waits on a picture being up waits on this.
      void done.then(
        () => {
          if (!live) return;
          setCanvasDrawn(true);
          // The file's own shape, not the decoded one's: what is decoded is capped at what this
          // display can show, and a reader asking a photograph's dimensions is asking about the
          // photograph.
          report(frame.naturalWidth, frame.naturalHeight, frame.hdr);
        },
        (err: unknown) => {
          if (painting.current?.done === done) painting.current = null;
          if (!live) return;
          // The element is spent rather than the picture unreadable, so what it needs is a
          // new element and not a report that the photograph is gone.
          if (err instanceof CanvasLost) {
            setCanvasDrawn(false);
            setAttempt((n) => n + 1);
            return;
          }
          // A frame that decoded and then could not be drawn is as blank as one that never
          // arrived, so it is reported the same way rather than left as an empty canvas the
          // stage believes in.
          missing.current(source, err instanceof CannotDrawHere);
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

    void decodeFrame(
      source,
      wholeRef.current,
      requestedRef.current ? 'interactive' : 'background',
    ).then(draw, (err: unknown) => {
      // Abandoned rather than absent: the reader stepped past this photograph while it was
      // being fetched, which is not a photograph the server is missing.
      if (!live || (err instanceof Error && err.message === 'superseded')) return;
      missing.current(source, err instanceof CannotDrawHere);
    });
    return () => {
      live = false;
    };
    // `photoKey` and `hold`, not just `source`: a canvas is kept while its URL holds, so a
    // frame carried into the next round - which every decisive verdict does, the winner
    // keeping its slot - would otherwise never report again, and the round would show one
    // photo whichever slot was asked for. Only the report reruns: repainting a canvas that
    // already holds its frame is a GPU upload per held neighbour on every step.
  }, [source, photoKey, hold, attempt, proof, devicePeakNits, waiting, fromVideo, shell]);

  const styled = (hidden: boolean): ReturnType<typeof stylex.props> =>
    stylex.props(
      stageStyles.content,
      zoomed && stageStyles.zoomed,
      state === 'ready' && stageStyles.ready,
      state === 'retiring' && styles.retiring,
      state === 'layer' && styles.layer,
      hidden && styles.hidden,
    );

  return (
    <>
      {(!fromVideo || canvasDrawn) && (
        // A canvas rather than an `<img>`, because the picture is a bitmap this page decoded and
        // holds: the browser neither chooses when to decode it nor drops it once it has. `role`
        // and `aria-label` because a canvas has no `alt`, and this one is a photograph.
        <canvas
          key={attempt}
          ref={handCanvas}
          role="img"
          aria-label={alt}
          {...styled(videoUp || shell)}
          aria-hidden={!shown || videoUp}
        />
      )}
      {video != null && (
        <video
          ref={videoRef}
          src={video}
          autoPlay
          loop
          muted
          playsInline
          disablePictureInPicture
          role="img"
          aria-label={alt}
          {...styled(!videoUp)}
          aria-hidden={!shown || !videoUp}
          onError={videoFailed}
        />
      )}
    </>
  );
}
