import { PathSegment, route } from '../../../../../src/schemas/route';

export type DetailMode = 'view' | 'edit' | 'print';

const MOCKUP = route(PathSegment.mockup());

/** The photograph's own path, with the mockup's segment off it. */
export function detailPath(pathname: string): string {
  return pathname.endsWith(MOCKUP) ? pathname.slice(0, -MOCKUP.length) : pathname;
}

export function mockupPath(pathname: string): string {
  return `${detailPath(pathname)}${MOCKUP}`;
}

export function detailMode(pathname: string, search: string): DetailMode {
  if (pathname.endsWith(MOCKUP)) return 'print';
  return new URLSearchParams(search).has('edit') ? 'edit' : 'view';
}
