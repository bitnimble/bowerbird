import { type RefObject, useEffect, useRef } from 'react';

/** Keeps a touch on `element` from scrolling the page while `holding` says a drag has it. */
export function useHoldScroll(element: RefObject<Element | null>, holding: () => boolean): void {
  const latest = useRef(holding);
  useEffect(() => {
    latest.current = holding;
  });
  useEffect(() => {
    const target = element.current;
    if (target == null) return;
    const hold = (event: Event): void => {
      if (latest.current() && event.cancelable) event.preventDefault();
    };
    target.addEventListener('touchmove', hold, { passive: false });
    return () => target.removeEventListener('touchmove', hold);
  }, [element]);
}
