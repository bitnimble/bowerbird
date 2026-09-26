import { useEffect, useState } from 'react';

const MOBILE = '(max-width: 860px)';
const TOUCH = '(pointer: coarse)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const onChange = (e: MediaQueryListEvent): void => setMatches(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

// A narrow screen has no column to spare, so chrome that sits beside the content
// on a desktop has to overlay it here. Kept in step with the breakpoint the
// stylesheet's mobile rules use.
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE);
}

/** A finger, rather than a narrow window: `useIsMobile` is the breakpoint, this is the pointer. */
export function useIsTouch(): boolean {
  return useMediaQuery(TOUCH);
}

export function pointerIsCoarse(): boolean {
  return globalThis.matchMedia != null && globalThis.matchMedia(TOUCH).matches;
}

/**
 * Whether the display shows light past SDR white, asked where it is used: a window dragged between
 * two screens changes the answer. Firefox says no on an HDR display, which is right for a canvas,
 * the one thing it composites in SDR there.
 */
export function displayIsHdr(): boolean {
  return globalThis.matchMedia != null && globalThis.matchMedia('(dynamic-range: high)').matches;
}
