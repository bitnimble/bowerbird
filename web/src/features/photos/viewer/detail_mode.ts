import { PathSegment, route } from '../../../../../src/schemas/route';
import { VIEWER_RENDITIONS, type ViewerRendition } from '../../../../../src/schemas/settings';

export type DetailMode = 'view' | 'edit' | 'print';

const MOCKUP = route(PathSegment.mockup());
const EDIT = route(PathSegment.edit());

/** The photograph's own path, with the editor's or the mockup's segment off it. */
export function detailPath(pathname: string): string {
  for (const mode of [MOCKUP, EDIT]) {
    if (pathname.endsWith(mode)) return pathname.slice(0, -mode.length);
  }
  return pathname;
}

export function mockupPath(pathname: string): string {
  return `${detailPath(pathname)}${MOCKUP}`;
}

export function editPath(pathname: string): string {
  return `${detailPath(pathname)}${EDIT}`;
}

/** What a navigation into the mockup carries as its state: the print, and the rendition to print. */
export type PrintRequest = { proof: 'print' | 'print3d'; rendition: ViewerRendition };

export function isPrintRequest(state: unknown): state is PrintRequest {
  return (
    typeof state === 'object' &&
    state != null &&
    'proof' in state &&
    'rendition' in state &&
    (state.proof === 'print' || state.proof === 'print3d') &&
    VIEWER_RENDITIONS.some((rendition) => rendition === state.rendition)
  );
}

export function detailMode(pathname: string): DetailMode {
  if (pathname.endsWith(MOCKUP)) return 'print';
  return pathname.endsWith(EDIT) ? 'edit' : 'view';
}
