import { desc } from 'drizzle-orm';
import { blob, index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// One file this library has been exported to, as the export stood (§10.5.1). A run of one
// photograph and a run of a thousand are the same rows under one run_id.
//
// What was true of the export is the export's own copy, so exporting, moving a slider and
// exporting again lists two rows carrying what each was actually rendered from. What is true of
// the photograph is read off the photograph, and follows it when it is moved.
//
// No REFERENCES on photo_id, deliberately. A history whose rows cascaded away would forget where a
// photograph went the moment it left the catalogue, which is when the file it was written to is
// the only copy left.
export const exports = sqliteTable(
  'exports',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    photoId: text('photo_id').notNull(),
    sourcePath: text('source_path').notNull(),
    // Null between the render and the client reporting where it wrote the file. A row that never
    // gets one is a file that never landed: not listed, and swept by the cull.
    outputPath: text('output_path'),
    edits: text('edits'), // EditDocSchema, JSON; null where none were applied
    // Beside the row rather than in a folder of its own: it is small, it belongs to exactly one
    // row, and a delete then takes it with the row rather than leaving a file for a sweep to find.
    thumbnail: blob('thumbnail'),
    exportedAt: text('exported_at').notNull(),
  },
  (t) => [
    index('idx_exports_when').on(desc(t.exportedAt)),
    // What the cull groups by and what both deletes name, on a table written to once per exported
    // file: without it a bulk export scans the whole history per photograph.
    index('idx_exports_run').on(t.runId),
  ],
);
