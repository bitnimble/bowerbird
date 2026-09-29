import { COMPOSITE_KINDS_SQL } from '../../schemas/photos';

/**
 * Whether the `photo_edits` row `edits` holds a step the reader took. A row holding only the
 * camera match, written beneath the history, renders the camera's own picture.
 */
export const EDITED = (edits: string): string => `${edits}.cursor > 0`;

/**
 * Whether any row this one composes is edited, for a `photos` aliased as `alias`.
 *
 * A predicate rather than a column: what a composite may be built from depends on its frames, and
 * a frame is edited or not whichever row is being asked about (`renditions::sourceFor`).
 */
export const INPUTS_EDITED = (alias: string): string => `EXISTS (
    SELECT 1 FROM photo_sources s JOIN photo_edits fe ON fe.photo_id = s.photo_id
     WHERE s.composed_id = ${alias}id AND ${EDITED('fe')})`;

/**
 * Whether edits make a row rendered rather than shown the cameras' own picture, for a `photos`
 * aliased as `alias`: `renditions::sourceFor`'s `edited`, a photograph's own document and a
 * composite's frames'.
 */
export const EDITS_RENDER = (alias: string): string =>
  `CASE WHEN json_extract(${alias}recipe, '$.kind') IN (${COMPOSITE_KINDS_SQL})
        THEN ${INPUTS_EDITED(alias)}
        ELSE EXISTS (SELECT 1 FROM photo_edits pe WHERE pe.photo_id = ${alias}id AND ${EDITED('pe')}) END`;

/** A develop document's stamp, as SQL over a `photo_edits` aliased `alias`. */
export type EditStamp = (alias: string) => string;

const storedStamp: EditStamp = (alias) => `${alias}.stamp`;

/** The newest develop document behind the rows this one composes, for a `photos` aliased `alias`. */
const INPUTS_EDITED_STAMP = (
  alias: string,
  stampOf: EditStamp,
): string => `(SELECT MAX(${stampOf('fe')})
    FROM photo_sources s JOIN photo_edits fe ON fe.photo_id = s.photo_id
   WHERE s.composed_id = ${alias}id)`;

/**
 * What a row's copies are built from, as the newest stamp behind them: its own document, and for a
 * composite its frames' documents and its recipe, which moves with `stamp_placement`.
 */
export const BUILT_FROM_STAMP = (
  alias: string,
  stampOf: EditStamp = storedStamp,
): string => `NULLIF(MAX(
    COALESCE((SELECT ${stampOf('oe')} FROM photo_edits oe WHERE oe.photo_id = ${alias}id), ''),
    COALESCE(${INPUTS_EDITED_STAMP(alias, stampOf)}, ''),
    COALESCE(CASE WHEN json_extract(${alias}recipe, '$.kind') IN (${COMPOSITE_KINDS_SQL})
                  THEN ${alias}stamp_placement END, '')), '')`;
