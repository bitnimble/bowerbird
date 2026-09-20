/**
 * What to show the user for something thrown, whatever it turned out to be.
 *
 * `String(x)` is the obvious thing to reach for and is wrong for the case that matters:
 * a thrown object renders as "[object Object]", which tells the user nothing and tells a
 * bug report less. Anything that is not an `Error` gets serialised instead.
 */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    // Circular, or a `toJSON` that throws.
    return String(error);
  }
}
