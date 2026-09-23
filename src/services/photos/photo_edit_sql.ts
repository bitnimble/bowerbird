import { COMPOSITE_KINDS_SQL } from '../../schemas/photos';

/**
 * Whether any row this one composes carries a develop document, for a `photos` aliased as `alias`.
 *
 * A predicate rather than a column: what a composite may be built from depends on its frames, and
 * a frame is edited or not whichever row is being asked about (`renditions::sourceFor`).
 */
export const INPUTS_EDITED = (alias: string): string => `EXISTS (
    SELECT 1 FROM photo_sources s JOIN photo_edits fe ON fe.photo_id = s.photo_id
     WHERE s.composed_id = ${alias}id)`;

/** A develop document's stamp, as SQL over a `photo_edits` aliased `alias`. */
export type EditStamp = (alias: string) => string;

const storedStamp: EditStamp = (alias) => `${alias}.stamp`;

/** The newest develop document behind the rows this one composes, for a `photos` aliased `alias`. */
const INPUTS_EDITED_STAMP = (alias: string, stampOf: EditStamp): string => `(SELECT MAX(${stampOf('fe')})
    FROM photo_sources s JOIN photo_edits fe ON fe.photo_id = s.photo_id
   WHERE s.composed_id = ${alias}id)`;

/**
 * What a row's copies are built from, as the newest stamp behind them: its own document, and for a
 * composite its frames' documents and its recipe, which moves with `stamp_placement`.
 */
export const BUILT_FROM_STAMP = (alias: string, stampOf: EditStamp = storedStamp): string => `NULLIF(MAX(
    COALESCE((SELECT ${stampOf('oe')} FROM photo_edits oe WHERE oe.photo_id = ${alias}id), ''),
    COALESCE(${INPUTS_EDITED_STAMP(alias, stampOf)}, ''),
    COALESCE(CASE WHEN json_extract(${alias}recipe, '$.kind') IN (${COMPOSITE_KINDS_SQL})
                  THEN ${alias}stamp_placement END, '')), '')`;
