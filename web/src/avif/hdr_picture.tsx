import * as stylex from '@stylexjs/stylex';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  REQUEST_ACTIVITY_HEADER,
  type RequestActivity,
} from '../../../src/schemas/request_activity';
import { hdrPictures, type HdrPictures, type HdrSource } from './hdr_pictures';

export interface ShownPicture {
  kind: 'video' | 'image';
  url: string;
}

/**
 * What to put on the page for `source`, from `HdrPictures`: null while the video standing in for
 * it is being made. `failed` is for a video that will not play, and puts the file in its place.
 */
export function useHdrPicture(
  source: HdrSource,
  { pictures = hdrPictures, activity }: { pictures?: HdrPictures; activity?: RequestActivity } = {},
): { shown: ShownPicture | null; failed: () => void } {
  const file = pictures.shownFile(source);
  const [made, setMade] = useState<ShownPicture | null>(null);
  const latest = useRef({ source, activity });
  latest.current = { source, activity };

  useEffect(() => {
    if (!pictures.throughVideo) return;
    const { source, activity } = latest.current;
    setMade(null);
    const abort = new AbortController();
    let url: string | null = null;
    void pictures
      .video(source, {
        signal: abort.signal,
        headers: activity == null ? undefined : { [REQUEST_ACTIVITY_HEADER]: activity },
      })
      .then(
        (video) => {
          if (abort.signal.aborted) {
            if (video != null) pictures.release(source, video);
            return;
          }
          url = video;
          setMade(video == null ? { kind: 'image', url: file } : { kind: 'video', url: video });
        },
        () => {
          if (!abort.signal.aborted) setMade({ kind: 'image', url: file });
        },
      );
    return () => {
      abort.abort();
      if (url != null) pictures.release(source, url);
    };
  }, [file, pictures]);

  const failed = useCallback(() => setMade({ kind: 'image', url: file }), [file]);
  return { shown: pictures.throughVideo ? made : { kind: 'image', url: file }, failed };
}

export function HdrPicture({
  source,
  alt,
  onShown,
  onError,
  style,
}: {
  source: HdrSource;
  /** Empty for a picture that is not content, which is then hidden from assistive technology. */
  alt: string;
  onShown?: () => void;
  onError?: () => void;
  style?: stylex.StyleXStyles;
}): JSX.Element | null {
  const { shown, failed } = useHdrPicture(source);
  if (shown == null) return null;
  if (shown.kind === 'image') {
    return (
      <img
        src={shown.url}
        alt={alt}
        aria-hidden={alt === '' || undefined}
        onLoad={onShown}
        onError={onError}
        {...stylex.props(style)}
      />
    );
  }
  return (
    <video
      src={shown.url}
      autoPlay
      loop
      muted
      playsInline
      disablePictureInPicture
      role="img"
      aria-label={alt}
      aria-hidden={alt === '' || undefined}
      onLoadedData={onShown}
      onError={failed}
      {...stylex.props(style)}
    />
  );
}
