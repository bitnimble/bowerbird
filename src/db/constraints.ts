// bun:sqlite surfaces constraint failures as an Error carrying a SQLITE_CONSTRAINT_*
// code. Used to translate a lost pre-check race (two requests pass a uniqueness
// check before either commits) into a 409 CONFLICT rather than a raw 500.
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}
