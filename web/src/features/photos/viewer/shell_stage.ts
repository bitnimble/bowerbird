import { useEffect, useState, type RefObject } from 'react';
import { shellStage } from '../../../api/transport';

/** An HDR frame for the shell to draw behind the page (`shellDrawsStage`), lit as `ShellStage`. */
export interface BehindPage {
  source: string;
  headroom: number;
  white: number;
}

/**
 * Whether the shell has drawn `behind` into `viewport`'s place, so the page's own frame can step
 * aside; false until it has, and whenever it cannot.
 */
export function useShellStage(
  viewport: RefObject<HTMLElement | null>,
  behind: BehindPage | null,
): boolean {
  const [drawn, setDrawn] = useState<string | null>(null);
  const source = behind?.source;
  const headroom = behind?.headroom;
  const white = behind?.white;
  useEffect(() => {
    const element = viewport.current;
    if (element == null || source == null || headroom == null || white == null) return;
    let current = true;
    let latest = 0;
    const url = new URL(source, window.location.href).href;
    const observer = new ResizeObserver(() => {
      // Once per resize: the zoom box the stage keeps has no position.
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const scale = window.devicePixelRatio;
      const ask = ++latest;
      // An overtaken ask answers false, which is no news about the one that overtook it.
      const answered = (shown: boolean): void => {
        if (current && ask === latest) setDrawn(shown ? source : null);
      };
      shellStage
        .show({
          url,
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
  // Not in the cleanup above: a new white re-asks for the same photo, which a hide in between would
  // have the shell fetch and decode again, and the page show its own frame meanwhile.
  const showing = source != null;
  useEffect(() => {
    if (!showing) return;
    return () => {
      setDrawn(null);
      shellStage.hide().catch(() => undefined);
    };
  }, [showing]);
  return source != null && drawn === source;
}
