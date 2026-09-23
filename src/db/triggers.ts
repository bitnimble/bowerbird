import { COMPOSITE_KINDS_SQL } from '../schemas/photos';
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
 * it liked, and `NOT_A_FRAME` hides a photograph that any live row claims as a frame, which is a
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
  return [photoInputTriggers(), renditionTriggers(), replicationTriggers()].join('\n');
}
