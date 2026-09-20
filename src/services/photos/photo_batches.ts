export const IN_CHUNK = 900;

// `size` is for a query that binds each value more than once - a chunk is a
// budget in *variables*, not in values.
export function* inChunks(values: readonly string[], size = IN_CHUNK): Generator<readonly string[]> {
  for (let i = 0; i < values.length; i += size) yield values.slice(i, i + size);
}
