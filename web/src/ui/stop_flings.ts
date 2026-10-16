const cancelScroll = (event: TouchEvent): void => {
  if (event.cancelable) event.preventDefault();
};

// TODO(react 19): return the listener's removal as a ref cleanup, and turn the `useEffect` in
// `photo_stage.tsx` and the `useCallback` merge in `edit_labels_dialog.tsx` into plain callback refs.
/** For every `touchAction: 'none'` surface a finger can flick; usable as a callback ref. */
export function stopFlings(element: HTMLElement | null): void {
  // `touchAction: 'none'` alone still lets Chromium fling off a flick: nothing scrolls, but the
  // fling runs about a second and the next tap anywhere on the page only cancels it, no click.
  element?.addEventListener('touchmove', cancelScroll, { passive: false });
}
