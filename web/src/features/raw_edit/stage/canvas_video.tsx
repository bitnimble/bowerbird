import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';

const styles = stylex.create({
  frame: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    pointerEvents: 'none',
  },
  loading: {
    display: 'none',
  },
});

type Slot = 0 | 1;

/**
 * A canvas's draw shown as video, over the canvas it stands in for: Firefox composites HDR for
 * video and nothing else. `mp4` is a one-frame MP4 per draw at the canvas's backing size, fitted
 * as the canvas fits its own, and `style` whatever else the canvas wears; the canvas keeps the
 * pointer and the accessible name.
 */
export function CanvasVideo({
  mp4,
  style,
}: {
  mp4: Uint8Array<ArrayBuffer> | null;
  style?: stylex.StyleXStyles;
}): JSX.Element | null {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const urls = useRef<[string | null, string | null]>([null, null]);
  const front = useRef<Slot | null>(null);
  const [shown, setShown] = useState<Slot | null>(null);

  useEffect(() => {
    if (mp4 == null) return;
    const loading: Slot = front.current === 0 ? 1 : 0;
    const video = (loading === 0 ? first : second).current;
    if (video == null) return;
    const url = URL.createObjectURL(new Blob([mp4], { type: 'video/mp4' }));
    const replaced = urls.current[loading];
    urls.current[loading] = url;
    if (replaced != null) URL.revokeObjectURL(replaced);
    // Swapped only once decoded: a video shown while it loads is blank between frames.
    const loaded = (): void => {
      front.current = loading;
      setShown(loading);
    };
    video.addEventListener('loadeddata', loaded, { once: true });
    video.src = url;
    return () => video.removeEventListener('loadeddata', loaded);
  }, [mp4]);

  useEffect(
    () => () => {
      for (const url of urls.current) if (url != null) URL.revokeObjectURL(url);
    },
    [],
  );

  if (mp4 == null) return null;
  return (
    <>
      {[first, second].map((ref, slot) => (
        <video
          key={slot}
          ref={ref}
          muted
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          aria-hidden
          {...stylex.props(styles.frame, style, shown !== slot && styles.loading)}
        />
      ))}
    </>
  );
}
