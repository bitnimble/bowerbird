import { PathSegment, route } from '../../../src/schemas/route';

// The viewer, under whichever collection the photo was opened from. The stack
// triage alongside it is a different screen with its own chrome.
const VIEWER_PATH = new RegExp(`${route(PathSegment.photos())}/[^/]+$`);

export function inViewer(pathname: string): boolean {
  return VIEWER_PATH.test(pathname);
}
