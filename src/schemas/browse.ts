import { z } from 'zod';

// One level of the server's filesystem, for the folder picker that adds a
// library. Directories only: the picker chooses where photographs live, and
// listing the files inside would be exposing the catalogue's contents to answer
// a question about its shape.
export const BrowseResponseSchema = z.object({
  path: z.string(),
  /** The directory above, or null at the filesystem root. */
  parent: z.string().nullable(),
  directories: z.array(z.object({ name: z.string(), path: z.string() })),
  // Whether the app could write in the folder being listed, so the add-library
  // dialog can tick "don't change anything in this folder" for it (§4.1). One
  // boolean per listing, not per child entry, and optional because the
  // in-library picker shares this shape and has nothing to say about it.
  writable: z.boolean().optional(),
});
export type BrowseResponse = z.infer<typeof BrowseResponseSchema>;
