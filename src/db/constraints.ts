import { newId } from '../schemas/id';

// bun:sqlite surfaces constraint failures as an Error carrying a SQLITE_CONSTRAINT_*
// code. Used to translate a lost pre-check race (two requests pass a uniqueness
// check before either commits) into a 409 CONFLICT rather than a raw 500.
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}

const MAX_ID_ATTEMPTS = 5;

/**
 * An id no row holds yet, for a caller that has to commit to one before the
 * insert that would catch the clash.
 */
export function unusedId(taken: (id: string) => boolean): string {
  for (let attempt = 1; ; attempt++) {
    const id = newId();
    if (!taken(id)) return id;
    if (attempt === MAX_ID_ATTEMPTS) throw new Error('could not draw an unused id');
  }
}

export function withNewId(insert: (id: string) => void): string {
  for (let attempt = 1; ; attempt++) {
    const id = newId();
    try {
      insert(id);
      return id;
    } catch (err) {
      // Not isUniqueViolation: a duplicate root_path or folder_path must not spend draws.
      const collided = err instanceof Error && (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_PRIMARYKEY';
      if (!collided || attempt === MAX_ID_ATTEMPTS) throw err;
    }
  }
}
