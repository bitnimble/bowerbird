import { useEffect, useRef, type RefObject } from 'react';
import { shellStage } from '../../../api/transport';

/** An HDR frame the shell has prepared, for it to show behind the page, lit as `ShellStage`. */
export interface BehindPage {
  source: string;
  headroom: number;
  white: number;
}

/**
 * Has the shell show `behind` in `viewport`'s place, and hide it once nothing is to be shown.
 * `refused` hears of a frame the shell would not draw, for the page to draw instead.
 */
export function useShellStage(
  viewport: RefObject<HTMLElement | null>,
  behind: BehindPage | null,
  refused: (source: string) => void,
): void {
  const refuse = useRef(refused);
  refuse.current = refused;
  const source = behind?.source;
  const headroom = behind?.headroom;
  const white = behind?.white;
  useEffect(() => {
    const element = viewport.current;
    if (element == null || source == null || headroom == null || white == null) return;
    let current = true;
    let latest = 0;
    const observer = new ResizeObserver(() => {
      // Once per resize: the zoom box the stage keeps has no position.
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const scale = window.devicePixelRatio;
      const ask = ++latest;
      // An overtaken ask answers false, which is no news about the one that overtook it.
      const answered = (shown: boolean): void => {
        if (current && ask === latest && !shown) refuse.current(source);
      };
      shellStage
        .show({
          url: source,
          left: Math.round(rect.left * scale),
          top: Math.round(rect.top * scale),
          width: Math.round(rect.width * scale),
          height: Math.round(rect.height * scale),
          headroom,
          white,
        })
        .then(answered, () => answered(false));
    });
    observer.observe(element);
    return () => {
      current = false;
      observer.disconnect();
    };
  }, [viewport, source, headroom, white]);
  // Not in the cleanup above: the next photo takes this one's place in the shell by itself, and
  // a hide in between would blank the window until it did.
  const showing = source != null;
  useEffect(() => {
    if (!showing) return;
    return () => {
      shellStage.hide().catch(() => undefined);
    };
  }, [showing]);
}
