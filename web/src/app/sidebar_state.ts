import { PathSegment, route } from '../../../src/schemas/route';

// The viewer, under whichever collection the photo was opened from, and its editor and print
// mockup, which are the same photograph on the same screen. The stack triage alongside it is a
// different screen with its own chrome.
const VIEWER_PATH = new RegExp(
  `${route(PathSegment.photos())}/[^/]+(${route(PathSegment.mockup())}|${route(PathSegment.edit())})?$`,
);

export function inViewer(pathname: string): boolean {
  return VIEWER_PATH.test(pathname);
}
