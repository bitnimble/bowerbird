/**
 * One element's own fullscreen, not the document's.
 *
 * Stack triage mounts two stages side by side, so a control reading the global
 * `fullscreenElement` would turn stage A's fullscreen off instead of turning
 * stage B's on.
 */
export function toggleFullscreenOf(element: Element | null): Promise<void> {
  // iPhone Safari has no element fullscreen at all, and calling the missing method
  // throws out of the click handler rather than rejecting.
  if (element == null || element.requestFullscreen == null) return Promise.resolve();
  if (document.fullscreenElement === element) return document.exitFullscreen();
  return element.requestFullscreen();
}
