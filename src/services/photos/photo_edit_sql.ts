/**
 * Whether any row this one composes carries a develop document, for a `photos` aliased as `alias`.
 *
 * A predicate rather than a column: what a composite may be built from depends on its frames, and
 * a frame is edited or not whichever row is being asked about (`renditions::sourceFor`).
 */
export const INPUTS_EDITED = (alias: string): string => `EXISTS (
    SELECT 1 FROM photo_sources s JOIN photo_edits fe ON fe.photo_id = s.photo_id
     WHERE s.composed_id = ${alias}id)`;

/** The newest develop document behind the rows this one composes, for a `photos` aliased `alias`. */
const INPUTS_EDITED_STAMP = (alias: string): string => `(SELECT MAX(fe.stamp)
    FROM photo_sources s JOIN photo_edits fe ON fe.photo_id = s.photo_id
   WHERE s.composed_id = ${alias}id)`;

/**
 * What a row's copies are built from, as the newest stamp behind them: its own document, and for a
 * composite its frames' documents and its recipe, which moves with `stamp_placement`.
 */
export const BUILT_FROM_STAMP = (alias: string): string => `NULLIF(MAX(
    COALESCE((SELECT oe.stamp FROM photo_edits oe WHERE oe.photo_id = ${alias}id), ''),
    COALESCE(${INPUTS_EDITED_STAMP(alias)}, ''),
    COALESCE(CASE WHEN json_extract(${alias}recipe, '$.kind') IN ('panorama', 'assembly')
                  THEN ${alias}stamp_placement END, '')), '')`;
