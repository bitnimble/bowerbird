// Types come straight from the server's Zod schemas as type-only imports, so the
// client can never drift from the API and nothing is added to the bundle.
import { DeletedCountSchema, type Ordering, QueuedCountSchema, UpdatedCountSchema } from '../../../src/schemas/common';
import {
  DeletePhotosRequestSchema,
  HidePhotosRequestSchema,
  MarkPhotosRequestSchema,
  type PhotoDaysRequest,
  PhotoDaysRequestSchema,
  type PhotoDaysResponse,
  PhotoDaysResponseSchema,
  type PhotoDetail,
  PhotoDetailSchema,
  PhotoIdsResponseSchema,
  type PhotoListResponse,
  PhotoListResponseSchema,
  type PhotoMarks,
  type PhotoModelsRequest,
  PhotoModelsRequestSchema,
  type PhotoModelsResponse,
  PhotoModelsResponseSchema,
  type PhotoNeighboursRequest,
  PhotoNeighboursRequestSchema,
  type PhotoPositionsRequest,
  PhotoPositionsRequestSchema,
  PhotoPositionsResponseSchema,
  type PhotoRangeRequest,
  PhotoRangeRequestSchema,
  type PhotoSummary,
  PhotoSummaryListSchema,
  type PhotoTarget,
  PhotoTargetSchema,
  type Triage,
  type UpdatePhotoRequest,
  UpdatePhotoRequestSchema,
} from '../../../src/schemas/photos';
import type { PrepareDevelop } from '../../../src/schemas/prepare_develop';
import { PathSegment, route } from '../../../src/schemas/route';
import { REQUEST_ACTIVITY_HEADER, type RequestActivity } from '../../../src/schemas/request_activity';
import type { ViewerRendition } from '../../../src/schemas/settings';
import { assetUrl } from './transport';
import { NothingSchema, request } from './request';

export interface PhotoListParams {
  offset?: number;
  limit?: number;
  /** Defaults on. Off for blocks after the first of a pass, which cannot change the total. */
  count?: boolean;
  is_missing?: boolean;
  /** Includes the photographs put away, which are otherwise left out. Honours `match`. */
  is_hidden?: boolean;
  no_shoot?: boolean;
  include_deleted?: boolean;
  is_deleted?: boolean;
  rated?: boolean;
  triage?: Triage[];
  ordering?: Ordering;
  q?: string;
  taken_from?: string;
  taken_to?: string;
  /** Bodies and lenses, spelled as the RAW header spelled them; sent comma-separated. */
  camera_models?: string[];
  lens_models?: string[];
  match?: 'all' | 'any';
  /** Every photograph of a stack as a row of its own, rather than the stack as one (§19.5.4). */
  expand_stacks?: boolean;
}

export function photoListQuery(params: PhotoListParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    // An empty list is no filter at all; sent, it would be `triage=` and a 400.
    if (value == null || (Array.isArray(value) && value.length === 0)) continue;
    search.set(key, String(value));
  }
  const value = search.toString();
  return value === '' ? '' : `?${value}`;
}

type AskedPicture =
  | { region: { x: number; y: number; width: number; height: number }; stage: number }
  | {
      level: number;
      at: [number, number, number, number];
      parts: [number, number, number, number][];
    };

function downloadUrl(photoId: string, form: 'original'): string {
  return assetUrl(route(PathSegment.image(), photoId, PathSegment.download(), form));
}

function shownQuery(asked?: AskedPicture): string[] {
  if (asked == null) return [];
  // The tiles a client is short of, in the pixels of the level it already holds tiles of. The one
  // thing it names a level for, and `Missing` on the server argues why that is safe here.
  if ('level' in asked) {
    const at = asked.at.map(Math.round).join(',');
    // The squares as well as the box: each source is decoded for the box bounding *its own*
    // squares, so an L costs what the L covers rather than what its corner does.
    const parts = asked.parts.map((tile) => tile.map(Math.round).join(',')).join(';');
    return [`level=${Math.round(asked.level)}`, `at=${at}`, `parts=${parts}`];
  }
  const { x, y, width, height } = asked.region;
  const region = [x, y, width, height].map((part) => part.toFixed(6)).join(',');
  return [`region=${region}`, `stage=${Math.round(asked.stage)}`];
}

export const photosApi = {
  // The list calls take a signal because a scroll abandons blocks faster than
  // they answer: without it every request a flick started stays on the wire,
  // competing with the ones the reader is actually waiting for.
  listLibrary: (libraryId: string, params: PhotoListParams, signal?: AbortSignal, activity?: RequestActivity): Promise<PhotoListResponse> =>
    request(
      PhotoListResponseSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.libraries(), libraryId, PathSegment.photos())}${photoListQuery(params)}`,
      undefined,
      { signal, activity: activity ?? (params.count === false ? 'background' : 'interactive') },
    ),
  listMissing: (libraryId: string, params: PhotoListParams, signal?: AbortSignal, activity?: RequestActivity): Promise<PhotoListResponse> =>
    request(
      PhotoListResponseSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.libraries(), libraryId, PathSegment.photos(), PathSegment.missing())}${photoListQuery(params)}`,
      undefined,
      { signal, activity: activity ?? (params.count === false ? 'background' : 'interactive') },
    ),
  get: (id: string, activity: RequestActivity = 'interactive'): Promise<PhotoDetail> =>
    request(PhotoDetailSchema, 'GET', route(PathSegment.api(), PathSegment.photos(), id), undefined, { activity }),
  // What a selection stands for, spelled out. Only the export asks: every other bulk
  // action names its target and lets the server resolve it privately.
  ids: (target: PhotoTarget): Promise<{ photo_ids: string[] }> =>
    request(
      PhotoIdsResponseSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.ids()),
      PhotoTargetSchema.parse(target),
    ),
  update: (id: string, body: UpdatePhotoRequest): Promise<PhotoDetail> =>
    request(PhotoDetailSchema, 'PATCH', route(PathSegment.api(), PathSegment.photos(), id), UpdatePhotoRequestSchema.parse(body)),
  // Every bulk call names its photos either by id or by position in a filtered
  // collection (§18.3.3), so a selection of a hundred thousand is one small
  // request rather than a client reading back every id first.
  // The bin stamps its rows with a batch the caller generates, and the undo names
  // that batch rather than every id: the selection resolves elsewhere once those
  // photos have left the collection, and a million ids would be a 36MB round
  // trip in each direction (§12.3). Generated client-side so the undo still
  // works if the answer never arrives.
  delete: (target: PhotoTarget, batch: string): Promise<{ deleted: number }> =>
    request(
      DeletedCountSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.delete()),
      DeletePhotosRequestSchema.parse({ target, batch }),
    ),
  restore: (target: PhotoTarget): Promise<void> =>
    request(
      NothingSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.restore()),
      PhotoTargetSchema.parse(target),
    ),
  mark: (target: PhotoTarget, marks: PhotoMarks): Promise<{ updated: number }> =>
    request(
      UpdatedCountSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.mark()),
      MarkPhotosRequestSchema.parse({ ...marks, target }),
    ),
  hide: (target: PhotoTarget, hidden: boolean): Promise<{ updated: number }> =>
    request(
      UpdatedCountSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.hide()),
      HidePhotosRequestSchema.parse({ target, hidden }),
    ),
  rebuildTiles: (target: PhotoTarget): Promise<{ queued: number }> =>
    request(
      QueuedCountSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.rebuildTiles()),
      PhotoTargetSchema.parse(target),
    ),
  refreshMetadata: (target: PhotoTarget): Promise<{ updated: number }> =>
    request(
      UpdatedCountSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.refreshMetadata()),
      PhotoTargetSchema.parse(target),
    ),
  // Where rows sit in a collection now, so open bands and the scroll anchor can
  // be re-placed after an import or a re-order instead of being thrown away
  // (§19.6.1). A key is a stack id or a photo id, and it names every position it
  // stands for: one collapsed row, or one per member uncollapsed (§19.5.4).
  positions: (body: PhotoPositionsRequest, signal?: AbortSignal): Promise<Record<string, number[]>> =>
    request(
      PhotoPositionsResponseSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.positions()),
      PhotoPositionsRequestSchema.parse(body),
      { signal, activity: 'background' },
    ),
  // What the viewer's arrows step through: the collection uncollapsed, so a stack
  // is one tile in the grid and every frame of it in the viewer (§19.5.3). Rows
  // rather than ids, because a warmed neighbour is fetched at the URL its own
  // stamps version - given only an id the stage paints one file and downloads
  // another when the row lands.
  neighbours: (body: PhotoNeighboursRequest, signal?: AbortSignal): Promise<PhotoSummary[]> =>
    request(
      PhotoSummaryListSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.neighbours()),
      PhotoNeighboursRequestSchema.parse(body),
      { signal, activity: 'background' },
    ),
  // The same listing asked for by its ends: hand it the photographs a stack lies
  // between and it answers with the stack, so nothing on this side has to know
  // which end of the collection's ordering is "after".
  range: (body: PhotoRangeRequest, signal?: AbortSignal): Promise<PhotoSummary[]> =>
    request(
      PhotoSummaryListSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.range()),
      PhotoRangeRequestSchema.parse(body),
      { signal, activity: 'background' },
    ),
  // The bodies and lenses this collection was shot with, which is what the filter
  // menu offers rather than every model the catalogue has ever seen.
  models: (body: PhotoModelsRequest, signal?: AbortSignal): Promise<PhotoModelsResponse> =>
    request(
      PhotoModelsResponseSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.models()),
      PhotoModelsRequestSchema.parse(body),
      { signal, activity: 'background' },
    ),
  // What the collection holds per day, which the filter calendar shades its dots by
  // and picks its opening month from.
  days: (body: PhotoDaysRequest, signal?: AbortSignal): Promise<PhotoDaysResponse> =>
    request(
      PhotoDaysResponseSchema,
      'POST',
      route(PathSegment.api(), PathSegment.photos(), PathSegment.days()),
      PhotoDaysRequestSchema.parse(body),
      { signal, activity: 'background' },
    ),

  // The URLs below are loaded by the browser itself - an `<img>`, an `EventSource`, a
  // download - so they cannot go through `send`, and under the desktop shell they carry its
  // own scheme instead (`assetUrl`). Everything after the prefix is the same path the API
  // serves, which is what keeps one set of routes for both.

  // The file the camera wrote, handed over as it is. No extension in the URL - the catalogue
  // holds several RAW formats, and the server names the download off the file it served.
  downloadUrl,

  // The rendition the viewer is showing, as a JPEG for the platform's share sheet: an HDR one
  // carries a gain map, so what a receiving application shows is the picture on screen rather
  // than a PQ AVIF it has never heard of. Named in the URL, unlike everywhere else here, because
  // which rendition is on screen is the client's own answer.
  shareUrl: (photoId: string, rendition: ViewerRendition): string =>
    assetUrl(route(PathSegment.image(), photoId, PathSegment.share(), rendition)),

  /**
   * What has been measured about this photograph, for a client about to open the RAW itself.
   *
   * Bytes nothing on this side reads: they are handed to the open, which skips most of a second of
   * measuring for having them. 404 until something has measured this photograph.
   */
  downloadRaw: async (photoId: string): Promise<Uint8Array<ArrayBuffer>> => {
    const reply = await fetch(downloadUrl(photoId, 'original'), { headers: { [REQUEST_ACTIVITY_HEADER]: 'interactive' } });
    if (!reply.ok) {
      // Named and quoted: this is the first request an open makes, so it is where a photograph
      // that is not there is found out, and "404" alone leaves a reader with nothing to act on.
      const detail = (await reply.text()).slice(0, 200);
      throw new Error(`could not open ${photoId}: ${reply.status} ${detail}`);
    }
    return new Uint8Array(await reply.arrayBuffer());
  },

  analysisUrl: (photoId: string): string => assetUrl(route(PathSegment.image(), photoId, PathSegment.analysis())),

  /**
   * One picture of this photograph, coded, for a client that will grade it itself.
   *
   * What the editor opens a composite through: a panorama is several photographs and a canvas of
   * hundreds of megapixels, so what crosses is the picture rather than the sources behind it.
   *
   * **The URL says what this client can show, never which level to serve.** With nothing, the whole
   * picture at the coarsest level it has, which is what a reader opens on. With `shown`, the window
   * of whichever level puts a sample on each of the stage's pixels - which is how a reader reaches a
   * canvas's own pixels past the point where a whole level fits a texture.
   *
   * Fractions rather than pixels: the canvas is the recipe's rather than the row's, so a client
   * naming its coordinates would have to be told the canvas before it could ask.
   *
   * `develop` is the settings the reader is previewing that the prepare runs before the samples
   * cross, where they differ from the last save.
   */
  preparedPictureUrl: (photoId: string, asked?: AskedPicture, develop?: PrepareDevelop): string => {
    const url = assetUrl(route(PathSegment.image(), photoId, PathSegment.prepare()));
    const query = shownQuery(asked);
    if (develop != null) query.push(`develop=${encodeURIComponent(JSON.stringify(develop))}`);
    return query.length === 0 ? url : `${url}?${query.join('&')}`;
  },
};
