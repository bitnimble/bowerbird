import { CameraFileFormatSchema, COMPOSITE_KINDS_SQL } from '../schemas/photos';
import { RENDERED_FORMATS } from '../utils/scan';
import { renditionVariant } from '../services/processing/renditions/renditions';
import { replicationTriggers } from '../services/replication/units';

/**
 * The triggers that keep `photo_inputs` and `photo_sources` in step with the recipes they index.
 *
 * One row per file the recipe names, which for the `file` kind is its path and for a composite is
 * nothing: what a composite names is other photographs, and the edge from one to those is theirs to
 * carry rather than a file this could list.
 *
 * Both inserts are gated on the **kind**, not on the shape of what the JSON happens to carry. A
 * recipe arrives from a peer byte-verbatim (`RecipeCellSchema` refines, never transforms), so a
 * `file` recipe with a `sources` array bolted on would otherwise index edges naming any photograph
 * it liked, and `NOT_STOOD_FOR` hides a photograph that any live row claims as a frame, which is a
 * paired peer emptying someone's grid one crafted row at a time.
 */
export function photoInputTriggers(): string {
  const index = `INSERT OR IGNORE INTO photo_inputs (library_id, photo_id, path)
      SELECT NEW.library_id, NEW.id, json_extract(NEW.recipe, '$.path')
       WHERE json_extract(NEW.recipe, '$.kind') = 'file';
    INSERT OR IGNORE INTO photo_sources (library_id, composed_id, photo_id, at)
      SELECT NEW.library_id, NEW.id, json_extract(source.value, '$.photoId'), source.key
        FROM json_each(NEW.recipe, '$.sources') AS source
       WHERE json_extract(NEW.recipe, '$.kind') IN (${COMPOSITE_KINDS_SQL})
         AND json_type(NEW.recipe, '$.sources') = 'array';`;
  return `
    CREATE TRIGGER IF NOT EXISTS photos_index_inputs_ins AFTER INSERT ON photos BEGIN ${index} END;
    CREATE TRIGGER IF NOT EXISTS photos_index_inputs_upd AFTER UPDATE OF recipe ON photos BEGIN
      DELETE FROM photo_inputs WHERE photo_id = NEW.id;
      DELETE FROM photo_sources WHERE composed_id = NEW.id;
      ${index}
    END;
    CREATE TRIGGER IF NOT EXISTS photos_forget_inputs AFTER DELETE ON photos BEGIN
      -- The foreign key cascades only where the pragma is on, and this table has to empty with the
      -- photograph whatever the connection was opened with: a row left behind is a path the next
      -- scan reconciles against a photograph that is gone.
      DELETE FROM photo_inputs WHERE photo_id = OLD.id;
      DELETE FROM photo_sources WHERE composed_id = OLD.id OR photo_id = OLD.id;
    END;
  `;
}

const RENDERED_FORMATS_SQL = RENDERED_FORMATS.map((format) => `'${format}'`).join(', ');

/** The folder a row's file is in, with its trailing slash, and the file's lowercased stem. */
const placeOf = (alias: string): { folder: string; stem: string } => {
  const path = `json_extract(${alias}.recipe, '$.path')`;
  const folderLength = `length(rtrim(${path}, replace(${path}, '/', '')))`;
  const name = `substr(${path}, ${folderLength} + 1)`;
  return {
    folder: `substr(${path}, 1, ${folderLength})`,
    stem: `lower(substr(${name}, 1, length(rtrim(${name}, replace(${name}, '.', ''))) - 1))`,
  };
};

/**
 * Whether `raw` and `file` are two files of one photograph (`photo_links`), with the terms
 * `idx_photos_library_order_taken` leads on stated for `sought`, so the other half is found by
 * a seek on the capture second.
 */
export function linkedPair(raw: string, file: string, sought: string): string {
  const known = sought === raw ? file : raw;
  return `${sought}.library_id = ${known}.library_id AND ${sought}.is_deleted IN (0, 1)
      AND (${sought}.date_taken IS NULL) = 0 AND ${sought}.date_taken = ${known}.date_taken
      AND ${raw}.format NOT IN (${RENDERED_FORMATS_SQL})
      AND ${file}.format IN (${CameraFileFormatSchema.options.map((format) => `'${format}'`).join(', ')})
      AND ${file}.camera_make IS ${raw}.camera_make AND ${file}.camera_model IS ${raw}.camera_model
      AND json_extract(${raw}.recipe, '$.kind') = 'file' AND json_extract(${file}.recipe, '$.kind') = 'file'
      AND ${placeOf(file).stem} = ${placeOf(raw).stem}
      AND ${placeOf(file).folder} = ${placeOf(raw).folder}`;
}

const LINKED_ON = [
  'recipe',
  'format',
  'date_taken',
  'camera_make',
  'camera_model',
  'library_id',
] as const;

/**
 * The triggers that keep `photo_links` in step with the columns a pair is matched on, and give
 * both halves of a new link each other's albums. Marks and labels replicate, so they are shared
 * by `reconcileLinks` under a stamp of its own.
 */
export function photoLinkTriggers(): string {
  // Only the links that stopped matching: one kept is not formed again, nor shared across again.
  const link = `DELETE FROM photo_links WHERE (raw_id = NEW.id OR camera_file_id = NEW.id)
      AND NOT EXISTS (SELECT 1 FROM photos raw, photos file
                       WHERE raw.id = photo_links.raw_id AND file.id = photo_links.camera_file_id
                         AND ${linkedPair('raw', 'file', 'file')});
    INSERT OR IGNORE INTO photo_links (library_id, raw_id, camera_file_id)
      SELECT NEW.library_id, raw.id, file.id FROM photos raw, photos file
       WHERE raw.id = NEW.id AND ${linkedPair('raw', 'file', 'file')};
    INSERT OR IGNORE INTO photo_links (library_id, raw_id, camera_file_id)
      SELECT NEW.library_id, raw.id, file.id FROM photos file, photos raw
       WHERE file.id = NEW.id AND ${linkedPair('raw', 'file', 'raw')};`;
  const albums = (into: string, from: string): string =>
    `INSERT OR IGNORE INTO album_photos (album_id, photo_id, date_added)
       SELECT album_id, NEW.${into}, date_added FROM album_photos WHERE photo_id = NEW.${from};`;
  return `
    CREATE TRIGGER IF NOT EXISTS photos_link_ins AFTER INSERT ON photos BEGIN ${link} END;
    CREATE TRIGGER IF NOT EXISTS photos_link_upd
      AFTER UPDATE OF ${LINKED_ON.join(', ')} ON photos
      WHEN ${LINKED_ON.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}
      BEGIN ${link} END;
    CREATE TRIGGER IF NOT EXISTS photos_unlink AFTER DELETE ON photos BEGIN
      DELETE FROM photo_links WHERE raw_id = OLD.id OR camera_file_id = OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS photo_links_albums AFTER INSERT ON photo_links BEGIN
      ${albums('raw_id', 'camera_file_id')}
      ${albums('camera_file_id', 'raw_id')}
    END;
  `;
}

/**
 * What a photograph owes when it arrives, and what goes when it does.
 *
 * A trigger rather than a repository call because a photograph arrives down several paths - a scan,
 * a peer's page, a restore - and one that missed a path would never be built, silently.
 *
 * Which range of `full` it owes is its library's, chosen once here: the other range's copy is built
 * when it is asked for.
 */
function renditionTriggers(): string {
  return `
    CREATE TRIGGER IF NOT EXISTS photos_owe_renditions AFTER INSERT ON photos BEGIN
      INSERT OR IGNORE INTO renditions (photo_id, variant, needs_build)
        VALUES (NEW.id, 'grid', 1);
      INSERT OR IGNORE INTO renditions (photo_id, variant, needs_build)
        SELECT NEW.id,
               CASE WHEN COALESCE((SELECT l.rendition_hdr FROM libraries l WHERE l.id = NEW.library_id), 0) = 1
                    THEN '${renditionVariant('full', true)}' ELSE '${renditionVariant('full', false)}' END,
               1;
    END;
    CREATE TRIGGER IF NOT EXISTS photos_forget_renditions AFTER DELETE ON photos BEGIN
      -- No foreign key to cascade on, so the rows would outlive the row they are about, and a
      -- photograph minted with that id next would read as built.
      DELETE FROM renditions WHERE photo_id = OLD.id;
    END;
  `;
}

/**
 * Every trigger the catalogue runs on, as one script.
 *
 * drizzle-kit does not diff triggers, so these are registered rather than generated. Re-registering
 * has to happen after **every** migration rather than once at install: SQLite drops a table's
 * triggers with the table, so a generated rebuild takes them out, and a photograph inserted after
 * that would index no inputs, owe no renditions and log no stamp.
 */
export function triggers(): string {
  return [
    photoInputTriggers(),
    photoLinkTriggers(),
    renditionTriggers(),
    replicationTriggers(),
  ].join('\n');
}
