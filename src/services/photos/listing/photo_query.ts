import type { Ordering } from '../../../schemas/common';
import { EditDocSchema } from '../../../schemas/photo_edits';
import { displaySize } from '../../../schemas/display_size';
import type { CompositeKind, Triage } from '../../../schemas/photos';
import { canvasOf, recipeOf } from '../../../schemas/recipes';
import type { RenditionSource } from '../../processing/workers/processing_types';
import { renditionVariant } from '../../processing/renditions/renditions';
import { FULL_VARIANT_OF_LIBRARY, owesRendition, renditionBuiltAt, renditionsBuiltAt } from '../../processing/renditions/renditions_repository';
import type { ViewerRendition } from '../../../schemas/settings';
import type { PhotoListFilters, UnresolvedDetail, UnresolvedSummary } from './photo_listing_repository';
import { INPUTS_EDITED } from '../photo_edit_sql';
import { PATH_OF } from '../paths/photo_paths_repository';

export function orderByClause(ordering: Ordering, prefix = 'photos.', reversed = false): string {
  const dir = (ascending: boolean): string => (ascending === !reversed ? 'ASC' : 'DESC');
  switch (ordering) {
    case 'added_asc':
      return `${prefix}date_added ${dir(true)}, ${prefix}id ${dir(true)}`;
    case 'added_desc':
      return `${prefix}date_added ${dir(false)}, ${prefix}id ${dir(false)}`;
    case 'taken_asc':
      return `${prefix}date_taken IS NULL ${dir(true)}, ${prefix}date_taken ${dir(true)}, ${prefix}id ${dir(true)}`;
    case 'taken_desc':
      return `${prefix}date_taken IS NULL ${dir(true)}, ${prefix}date_taken ${dir(false)}, ${prefix}id ${dir(false)}`;
  }
}

export function firstPhotoOrderBy(orderingColumn: string, prefix = 'p.'): string {
  return `CASE ${orderingColumn} WHEN 'taken_asc' THEN ${prefix}date_taken IS NULL WHEN 'taken_desc' THEN ${prefix}date_taken IS NULL END,
    CASE ${orderingColumn} WHEN 'taken_asc' THEN ${prefix}date_taken WHEN 'added_asc' THEN ${prefix}date_added END ASC,
    CASE ${orderingColumn} WHEN 'taken_desc' THEN ${prefix}date_taken WHEN 'added_desc' THEN ${prefix}date_added END DESC,
    CASE ${orderingColumn} WHEN 'taken_asc' THEN ${prefix}id WHEN 'added_asc' THEN ${prefix}id END ASC,
    CASE ${orderingColumn} WHEN 'taken_desc' THEN ${prefix}id WHEN 'added_desc' THEN ${prefix}id END DESC`;
}

function hiddenShootIds(exempt?: string): string {
  return `SELECT s.id FROM shoots s JOIN shoots h
            ON h.is_hidden = 1 AND h.library_id = s.library_id
               AND (s.id = h.id
                    OR (s.folder_path >= h.folder_path || '/' AND s.folder_path < h.folder_path || '0'))
          ${exempt == null ? '' : `WHERE s.id <> ${exempt}`}`;
}

export function hiddenShootsSql(exempt?: string): string {
  return hiddenShootIds(exempt);
}

export function hiddenIs(prefix: string, hidden: boolean, exempt?: string): string {
  const own = `${prefix}is_hidden = ${hidden ? 1 : 0}`;
  const shoots = hiddenShootIds(exempt);
  return hidden ?
      `(${own} OR ${prefix}shoot_id IN (${shoots}))`
    : `(${own} AND (${prefix}shoot_id IS NULL OR ${prefix}shoot_id NOT IN (${shoots})))`;
}

// How much of a range one request may answer with. The caller this exists for
// wants a stack's run, and a manual stack has no bound of its own.
export const RANGE_LIMIT = 1000;

// The two build times a client versions its URLs by: the grid tile's own, and the
// latest of the viewer's, which are written at different moments.
//
// The composited camera view is among them, where a photograph's is not: it is a copy this row
// builds rather than bytes inside a file, so the URL that 404d before it existed has to move once
// it does (`renditionVersion`).
const TILE_BUILT_AT = `${renditionBuiltAt(`'grid'`, 'photos.id')} AS tile_built_at`;

export const RENDITIONS_BUILT_AT = `${renditionsBuiltAt(
  [
    renditionVariant('full', false),
    renditionVariant('full', true),
    renditionVariant('max', false),
    renditionVariant('max', true),
    renditionVariant('embedded', false),
  ],
  'photos.id',
)} AS renditions_built_at`;

// Qualified with `photos.` because listByAlbum joins album_photos, which also has
// a date_added column (bare names would be ambiguous).
// `is_edited` is an EXISTS rather than the document itself: which rendition a photo is
// drawn from turns on whether it has one at all (§18.5), and a listing that carried every
// develop document would read a page of JSON to answer a boolean.
//
// What a row is composed as, which draws a composite's badge and is what the badge opens. On every
// read of a row, not just the grid's: the viewer's run and the detail are how a merge is reached
// straight after it is saved, before any listing has loaded it.
const COMPOSITE_KIND = `CASE WHEN json_extract(photos.recipe, '$.kind') IN ('panorama', 'assembly')
    THEN json_extract(photos.recipe, '$.kind') END AS composite_kind,
  json_array_length(photos.recipe, '$.sources') AS frame_count`;

// `frames_edited` beside it answers the same question one row further out, and the two are not
// interchangeable on a composite: its own document is the framing the merge wrote, which the
// cameras' pictures carry as well as a render does, where a *frame's* is an edit no JPEG of that
// frame has in it (`renditions::sourceFor`).
export function summaryColumns(): string {
  return `photos.id, photos.library_id, photos.shoot_id, ${COMPOSITE_KIND}, ${PATH_OF} AS file_path, photos.width, photos.height, photos.date_taken, photos.date_added, photos.date_updated, ${TILE_BUILT_AT}, ${RENDITIONS_BUILT_AT}, photos.viewer_rendition, photos.triage, photos.rating, photos.is_missing, photos.is_deleted, ${hiddenIs('photos.', true)} AS is_hidden, photos.stack_id, EXISTS (SELECT 1 FROM photo_edits e WHERE e.photo_id = photos.id) AS is_edited, ${INPUTS_EDITED('photos.')} AS frames_edited`;
}

// How wide a stack counts in a listing (§19.5.2).
//
// A shoot shows the whole stack and dims the members that are not in it, so its
// tile has to say how many photographs the stack holds. An album is strict about
// what it contains, so there its tile may only count the members the album
// holds. Both are the same window function over different row sets, which is why
// this is a flag and not two queries.
export type StackScope = 'collection' | 'album';

/**
 * Which row of a stack a listing shows: a **filter**, not a window function.
 *
 * This is the whole reason listings are still fast. A window function has to see
 * every scoped row before `LIMIT` can take a hundred of them, so it sorts the
 * collection for every block a scroll fetches - measured at 179ms a page against
 * 0.9ms for the same listing without stacks, on every library whether or not it
 * has any. Expressed as a filter, the ordering index is walked and stops at the
 * page, and a 200k library costs 5ms.
 *
 * Two arms:
 *
 * - the stored `is_representative` flag, which is the fast answer for almost
 *   every row: it is set on every unstacked photo and on one member of each
 *   stack, so the common case is an equality test;
 * - failing that, "this stack has no visible flagged member, and no visible
 *   member of it sorts before me" - which promotes the next survivor when the
 *   flagged one is hidden by a filter, by the bin, or by being in another shoot.
 *
 * The flag is therefore a hint rather than a truth. Stale or missing, the second
 * arm still returns the right row and only costs a little more; what it must
 * never be is set on *two* visible members of one stack, which would show that
 * stack twice. A partial unique index makes that an error rather than a
 * duplicate (`migrate.ts`).
 *
 * `memberScope` is how a member of the same stack is recognised as being in this
 * listing at all - the shoot it must be in, the album that must hold it - so a
 * shoot promotes to the newest *in-shoot* member and never shows a tile for a
 * photograph that is not in it.
 */
export interface MemberScope {
  /** A predicate on alias `m`, or empty when the whole library is in scope. */
  sql: string;
  params: (string | number)[];
}

/**
 * A frame a panorama was composed from, which the panorama now stands for.
 *
 * **Hidden by the composite that names it, exactly as a stack member is hidden by its
 * representative.** Merging is the reader saying these frames are one picture; leaving them in the
 * grid beside it shows the same pan eight times. The band the badge opens is where they still are,
 * and an uncollapsed listing shows them like any other member.
 *
 * Not a promotion like the stack rule: a composite is a row of its own rather than one of the
 * frames wearing a hat, so there is nothing to choose between - the frames simply go.
 *
 * **Only while the composite is live.** Binning a panorama gives its frames back to the library:
 * merging said "these are one picture" and binning takes that back, so the eight photographs
 * return and can be binned themselves, or merged again. Without the `is_deleted` test they would
 * stay hidden behind a row that is itself in the Bin - eight photographs gone from the library
 * with nothing on screen to say where, which is the one outcome a delete must never produce.
 * Restoring it hides them again, and hard-deleting it drops the edges outright
 * (`photos_forget_inputs`).
 */
const notAFrame = (alias: string): string => `NOT EXISTS (
    SELECT 1 FROM photo_sources s JOIN photos composite ON composite.id = s.composed_id
     WHERE s.photo_id = ${alias}id AND composite.is_deleted = 0)`;

export const NOT_A_FRAME = notAFrame('photos.');

export function representativeFilter(filters: PhotoListFilters, member: MemberScope): { sql: string; params: (string | number)[] } {
  // An uncollapsed listing keeps every stack *member*, so the promotion below is that filter's
  // absence rather than a filter of its own (§19.5.4) - but a panorama's frames are not stack
  // members and "expand stacks" is not "dismantle my panoramas". A composite stands for its
  // frames in every listing, collapsed or not; the band its badge opens is how they are reached.
  if (filters.expandStacks === true) return { sql: NOT_A_FRAME, params: [] };
  const { clauses, params } = conditions(filters, 'm.');
  // A member merged into a live panorama is not in the listing either, and leaving it out of
  // this test is how a whole stack vanishes: the flagged member holds the flag while being
  // hidden by `NOT_A_FRAME`, so the promotion below finds a representative and refuses to
  // promote the siblings that are still visible.
  const visible = [notAFrame('m.'), ...(member.sql === '' ? [] : [member.sql]), ...clauses].join(' AND ');
  const inListing = ` AND ${visible}`;
  const memberParams = [...member.params, ...params];
  const taken = (alias: string) => `COALESCE(${alias}date_taken, ${alias}date_added)`;
  return {
    sql: `${NOT_A_FRAME} AND (photos.is_representative = 1 OR (photos.stack_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM photos m
          WHERE m.stack_id = photos.stack_id AND m.is_representative = 1${inListing})
        AND NOT EXISTS (
          SELECT 1 FROM photos m
          WHERE m.stack_id = photos.stack_id${inListing}
            AND (${taken('m.')} > ${taken('photos.')}
              OR (${taken('m.')} = ${taken('photos.')} AND m.id > photos.id)))))`,
    params: [...memberParams, ...memberParams],
  };
}

/**
 * How many photographs the tile stands for.
 *
 * A correlated count rather than a window, and only ever evaluated for the rows
 * a page actually returns. In a shoot or the library it is the stack's whole
 * membership, because those views show the stack whole and dim the members that
 * are elsewhere; in an album it is what the album holds, because an album is
 * strict (§19.5.2). Either way it honours the listing's own view of the bin, so
 * the number on the tile and the set an action touches are the same.
 */
export function sizeExpression(filters: PhotoListFilters, counting: MemberScope): { sql: string; params: (string | number)[] } {
  // Uncollapsed, a row stands for the one photograph it is, so nothing in the
  // grid may read it as a stack (§19.5.4).
  if (filters.expandStacks === true) return { sql: '1', params: [] };
  const { clauses, params } = conditions(filters, 'm.');
  const visible = [...(counting.sql === '' ? [] : [counting.sql]), ...clauses].join(' AND ');
  return {
    sql: `CASE WHEN photos.stack_id IS NULL THEN 1 ELSE (
            SELECT COUNT(*) FROM photos m WHERE m.stack_id = photos.stack_id${visible === '' ? '' : ` AND ${visible}`}
          ) END`,
    params: [...counting.params, ...params],
  };
}

// Qualified: getById joins libraries to resolve ordering_date, so `id` etc. would
// otherwise be ambiguous.
export function detailColumns(): string {
  return `photos.id, photos.library_id, photos.shoot_id, photos.width, photos.height, ${COMPOSITE_KIND},
    photos.orientation, ${PATH_OF} AS file_path, photos.file_hash, photos.date_taken, photos.date_taken_offset, photos.date_added,
    photos.date_updated, ${TILE_BUILT_AT}, ${RENDITIONS_BUILT_AT},
    ${owesRendition(`'grid'`, 'photos.id')} AS needs_tile,
    ${owesRendition(FULL_VARIANT_OF_LIBRARY, 'photos.id')} AS needs_renditions,
    photos.processing_error,
    photos.latitude, photos.longitude, photos.rating, photos.triage, photos.is_missing,
    photos.is_deleted, ${hiddenIs('photos.', true)} AS is_hidden,
    photos.notes, photos.file_size, photos.iso, photos.shutter_speed, photos.aperture,
    photos.focal_length, photos.camera_make, photos.camera_model, photos.lens_model, photos.rendition_source, photos.viewer_rendition,
    photos.stack_id, photos.recipe, ${INPUTS_EDITED('photos.')} AS frames_edited`;
}

export interface SummaryRow {
  id: string;
  library_id: string;
  shoot_id: string | null;
  stack_id: string | null;
  composite_kind: CompositeKind | null;
  frame_count: number | null;
  // Absent from the queries that read a photo rather than a listing; those rows
  // stand for themselves, which is a stack of one.
  stack_size?: number;
  /** Read out of the recipe, and so null for a row that is not one file (`PATH_OF`). */
  file_path: string | null;
  width: number;
  height: number;
  date_taken: string | null;
  date_added: string;
  date_updated: string | null;
  tile_built_at: string | null;
  renditions_built_at: string | null;
  viewer_rendition: ViewerRendition | null;
  is_edited: number;
  frames_edited: number;
  triage: string | null;
  rating: number;
  is_missing: number;
  is_deleted: number;
  is_hidden: number;
}

// `is_edited` is the one summary column `detailColumns` does not select: the detail answers the
// same question from `edited` below, which it needs the settings of anyway. Omitted rather than
// inherited, or it is typed as a number and is `undefined` at runtime, and the next reader to
// mirror `toSummary`'s `is_edited === 1` here gets a silent false.
export interface DetailRow extends Omit<SummaryRow, 'is_edited'> {
  /** As stored, JSON; `toDetail` parses it. */
  recipe: string;
  orientation: number;
  // The stored develop settings as JSON, or absent where the photo has none. A
  // subquery rather than a join because the detail read is one row and this is one
  // optional value on it. Two things are read out of it: whether the photo is edited
  // at all - the camera's own JPEG cannot stand in for the picture once it is - and
  // the geometry, which decides the shape the grid lays the tile out at.
  edited?: string | null;
  file_hash: string | null;
  // Detail only: a grid tile is labelled with a wall clock, and a zone per tile
  // would be noise on 100 of them.
  date_taken_offset: string | null;
  needs_tile: number;
  needs_renditions: number;
  processing_error: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  file_size: number | null;
  iso: number | null;
  shutter_speed: number | null;
  aperture: number | null;
  focal_length: number | null;
  camera_make: string | null;
  camera_model: string | null;
  lens_model: string | null;
  rendition_source: RenditionSource | null;
  lib_ordering: string; // the owning library's ordering, for ordering_date
}

// NULL in the column is the untriaged state on the wire.
function toTriage(value: string | null): Triage {
  return value === 'picked' || value === 'rejected' ? value : 'untriaged';
}

export function orderingDate(ordering: Ordering, row: Pick<SummaryRow, 'date_taken' | 'date_added'>): string | null {
  return ordering === 'taken_asc' || ordering === 'taken_desc' ? row.date_taken : row.date_added;
}

export function toSummary(row: SummaryRow, ordering: Ordering): UnresolvedSummary {
  return {
    id: row.id,
    library_id: row.library_id,
    shoot_id: row.shoot_id,
    file_path: row.file_path,
    width: row.width,
    height: row.height,
    ordering_date: orderingDate(ordering, row),
    triage: toTriage(row.triage),
    rating: row.rating,
    is_missing: row.is_missing === 1,
    is_deleted: row.is_deleted === 1,
    is_hidden: row.is_hidden === 1,
    date_updated: row.date_updated,
    tile_built_at: row.tile_built_at,
    renditions_built_at: row.renditions_built_at,
    viewer_rendition: row.viewer_rendition,
    is_edited: row.is_edited === 1,
    frames_edited: row.frames_edited === 1,
    stack_id: row.stack_id,
    stack_size: row.stack_size ?? 1,
    composite_kind: row.composite_kind,
    frame_count: row.frame_count ?? 0,
  };
}

/**
 * The shape this photo shows at, once its geometry is applied.
 *
 * The file's own dimensions for anything uncropped, which is almost everything - including
 * every photo whose document this build cannot read. A grid tile at the wrong aspect is a
 * worse failure than a grid tile at the file's aspect, and the second is what an unedited
 * photo gets anyway.
 *
 * **A composite's document is applied to its canvas, never to its row.** A merge frames the
 * canvas to what the sources cover and writes *that* as the row's size, and writes the same
 * framing as the photograph's crop so a reader can move it like any other - so the two numbers
 * here have already had the crop taken off them, and taking it off again squares it. A pan framed
 * to 0.8 by 0.7 of its canvas laid out at 0.64 by 0.49 of it.
 */
function displayed(row: DetailRow): { display_width: number; display_height: number } {
  const same = { display_width: row.width, display_height: row.height };
  if (row.edited == null) return same;
  try {
    const parsed = EditDocSchema.safeParse(JSON.parse(row.edited));
    if (!parsed.success) return same;
    const [whole = row.width, tall = row.height] = canvasOf(recipeOf(row.recipe)) ?? [row.width, row.height];
    const size = displaySize(whole, tall, parsed.data);
    return { display_width: size.width, display_height: size.height };
  } catch {
    return same;
  }
}

export function toDetail(row: DetailRow, albumIds: string[]): UnresolvedDetail {
  return {
    id: row.id,
    library_id: row.library_id,
    shoot_id: row.shoot_id,
    width: row.width,
    height: row.height,
    ordering_date: orderingDate(row.lib_ordering as Ordering, row),
    orientation: row.orientation,
    file_path: row.file_path,
    recipe: recipeOf(row.recipe),
    file_hash: row.file_hash,
    date_taken: row.date_taken,
    date_taken_offset: row.date_taken_offset,
    date_added: row.date_added,
    date_updated: row.date_updated,
    tile_built_at: row.tile_built_at,
    renditions_built_at: row.renditions_built_at,
    needs_tile: row.needs_tile === 1,
    needs_renditions: row.needs_renditions === 1,
    processing_error: row.processing_error,
    latitude: row.latitude,
    longitude: row.longitude,
    rating: row.rating,
    triage: toTriage(row.triage),
    is_missing: row.is_missing === 1,
    is_deleted: row.is_deleted === 1,
    is_hidden: row.is_hidden === 1,
    notes: row.notes,
    file_size: row.file_size,
    iso: row.iso,
    shutter_speed: row.shutter_speed,
    aperture: row.aperture,
    focal_length: row.focal_length,
    camera_make: row.camera_make,
    camera_model: row.camera_model,
    lens_model: row.lens_model,
    rendition_source: row.rendition_source,
    viewer_rendition: row.viewer_rendition,
    // A photo read on its own stands for itself, whatever stack it belongs to:
    // the detail view opens one photograph, and collapsing is a property of a
    // listing rather than of a row.
    stack_id: row.stack_id,
    stack_size: 1,
    composite_kind: row.composite_kind,
    frame_count: row.frame_count ?? 0,
    // All resolved by the service, which knows the library: they need its data
    // directory to stat or to build a path from, and its rendition settings. The
    // repository has no business doing either.
    original_path: null,
    // The service's to answer: it holds the library, and this is a stat.
    has_original: false,
    is_edited: row.edited != null,
    frames_edited: row.frames_edited === 1,
    ...displayed(row),
    renditions: null,
    album_ids: albumIds,
  };
}

// What a stack's other members are, for the two questions a collapsed listing
// asks about them (§19.5.1). `promotion` is which of them may stand for the
// stack here - a shoot's tile must be a photograph in that shoot - and `counting`
// is which of them the number on the tile is counting. They differ for a shoot,
// which shows the stack whole and dims the members that are elsewhere.
export const WHOLE_STACK: MemberScope = { sql: '', params: [] };

export const inAlbum = (albumId: string): MemberScope => ({
  sql: 'EXISTS (SELECT 1 FROM album_photos map WHERE map.photo_id = m.id AND map.album_id = ?)',
  params: [albumId],
});

export const inShoot = (shootId: string): MemberScope => ({ sql: 'm.shoot_id = ?', params: [shootId] });

// A listing of one shoot's photographs, which is the one place a hidden shoot does not hide them:
// the reader asked this shoot what it holds, and answering nothing is a page that opens onto a
// folder full of pictures and says it is empty. This shoot only - a stack straddling some *other*
// hidden shoot still shows the half that is in this one, and counts only that half (`hiddenIs`).
export const ownShoot = (shootId: string, filters: PhotoListFilters): PhotoListFilters => ({
  ...filters,
  exemptShoot: shootId,
});

/**
 * Everything a listing filters by, written against one table alias.
 *
 * Taking the alias as an argument is what lets the promotion clause (§19.5.1)
 * ask about a stack's *other* members under exactly the filters the listing is
 * running: a second copy of this would drift, and a listing whose promotion
 * disagreed with its own filter would show a stack twice or not at all.
 */
export function conditions(filters: PhotoListFilters, prefix: string): { clauses: string[]; params: (string | number)[] } {
  // Scope says which rows are in play at all; user holds the filter chips. They
  // are built separately because only the chips honour `match`.
  const scope: string[] = [];
  const scopeParams: (string | number)[] = [];
  const user: string[] = [];
  const userParams: (string | number)[] = [];
  const taken = `COALESCE(${prefix}date_taken, ${prefix}date_added)`;

  if (!filters.includeDeleted) scope.push(`${prefix}is_deleted = 0`);
  // Hiding is a default, not a scope: unasked it excludes, and asked for it is a chip like any
  // other. So `isHidden` is stated in the two halves separately - the exclusion intersects, because
  // it is where every listing starts, and the inclusion unions, so "hidden or picked" is a grid
  // holding both rather than the hidden picks alone.
  //
  // The Bin says nothing either way: a photograph binned while hidden would otherwise be in no
  // listing at all - out of the live ones by its flag and out of the Bin by the same clause - which
  // is the one outcome §12 exists to prevent.
  const exempt = filters.exemptShoot == null ? undefined : '?';
  if (filters.isDeleted !== true && filters.isHidden !== true) {
    scope.push(hiddenIs(prefix, false, exempt));
    if (filters.exemptShoot != null) scopeParams.push(filters.exemptShoot);
  }
  if (filters.noShoot === true) scope.push(`${prefix}shoot_id IS NULL`);
  if (filters.isDeleted != null) {
    scope.push(`${prefix}is_deleted = ?`);
    scopeParams.push(filters.isDeleted ? 1 : 0);
  }
  if (filters.search != null) {
    // LIKE is case-insensitive for ASCII in SQLite, which is what filenames are.
    // Any input matching, so a composite is found by the name of any frame it holds, which is
    // what someone typing a filename into a library of them means - and a composite has no input
    // of its own, so without the second arm it can be found by no filename at all.
    scope.push(`(EXISTS (SELECT 1 FROM photo_inputs i WHERE i.photo_id = ${prefix}id AND i.path LIKE ?)
      OR EXISTS (SELECT 1 FROM photo_sources s JOIN photo_inputs i ON i.photo_id = s.photo_id
                  WHERE s.composed_id = ${prefix}id AND i.path LIKE ?))`);
    scopeParams.push(`%${filters.search}%`, `%${filters.search}%`);
  }
  // COALESCE rather than date_taken alone: a file the camera never dated still
  // has to be reachable, and this is the same date the grid sorts and labels by.
  if (filters.takenFrom != null) {
    scope.push(`${taken} >= ?`);
    scopeParams.push(filters.takenFrom);
  }
  if (filters.takenTo != null) {
    // The bound is a whole day but the column is a timestamp, so compare against
    // the start of the next one.
    scope.push(`${taken} < date(?, '+1 day')`);
    scopeParams.push(filters.takenTo);
  }
  // Scope rather than chips: "shot on this body" narrows whatever set the chips
  // describe, the way the date range and the filename do. Unioned within
  // themselves, so ticking two bodies is either of them.
  for (const [column, wanted] of [
    ['camera_model', filters.cameraModels],
    ['lens_model', filters.lensModels],
  ] as const) {
    if (wanted == null || wanted.length === 0) continue;
    scope.push(`${prefix}${column} IN (${wanted.map(() => '?').join(', ')})`);
    scopeParams.push(...wanted);
  }

  if (filters.isMissing != null) {
    user.push(`${prefix}is_missing = ?`);
    userParams.push(filters.isMissing ? 1 : 0);
  }
  // A chip, so `match: 'any'` is what puts the hidden beside the live rather than in place of them.
  // Only ever the asking form: not asked for, hiding is the default exclusion above.
  if (filters.isHidden === true && filters.isDeleted !== true) {
    user.push(hiddenIs(prefix, true, exempt));
    if (filters.exemptShoot != null) userParams.push(filters.exemptShoot);
  }
  if (filters.rated != null) user.push(filters.rated ? `${prefix}rating > 0` : `${prefix}rating = 0`);
  if (filters.triage != null && filters.triage.length > 0) {
    // NULL is the untriaged bucket, so it needs an IS NULL arm rather than an IN.
    const wanted = filters.triage.filter((t) => t !== 'untriaged');
    const arms: string[] = [];
    if (filters.triage.includes('untriaged')) arms.push(`${prefix}triage IS NULL`);
    if (wanted.length > 0) {
      arms.push(`${prefix}triage IN (${wanted.map(() => '?').join(', ')})`);
      userParams.push(...wanted);
    }
    user.push(`(${arms.join(' OR ')})`);
  }

  const combined = filters.match === 'any' && user.length > 1 ? [`(${user.join(' OR ')})`] : user;
  return { clauses: [...scope, ...combined], params: [...scopeParams, ...userParams] };
}

export function scoped(
  fromWhere: string,
  baseParams: string[],
  filters: PhotoListFilters,
): { where: string; params: (string | number)[] } {
  const { clauses, params } = conditions(filters, 'photos.');
  return {
    where: clauses.length ? `${fromWhere} AND ${clauses.join(' AND ')}` : fromWhere,
    params: [...baseParams, ...params],
  };
}

export function uncollapsed(
  fromWhere: string,
  baseParams: string[],
  filters: PhotoListFilters,
): { where: string; params: (string | number)[] } {
  const result = scoped(fromWhere, baseParams, filters);
  return { where: `${result.where} AND ${NOT_A_FRAME}`, params: result.params };
}
