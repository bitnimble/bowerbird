import { z } from 'zod';
import { LibrarySchema, LibraryScanStatusSchema } from './libraries';

export const ActivityKindSchema = z.enum([
  'syncing', 'fetching', 'sending', 'sending_renditions', 'sending_to_tv', 'receiving', 'backing_up', 'restoring_backup',
  'rendering', 'local_rendering', 'preparing', 'merging', 'exporting', 'sharing', 'refreshing_metadata',
  'grouping', 'checking_files', 'reconciling', 'offloading', 'catalogue_backup',
  'pruning', 'measuring', 'checking_quality',
]);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const ActivitySchema = z.object({
  kind: ActivityKindSchema,
  count: z.number().int().positive(),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const LibraryActivitySchema = LibrarySchema.extend({
  scan: LibraryScanStatusSchema,
  activities: z.array(ActivitySchema),
});
export type LibraryActivity = z.infer<typeof LibraryActivitySchema>;

export const ActivitySnapshotSchema = z.object({
  libraries: z.array(LibraryActivitySchema),
  global: z.array(ActivitySchema),
});
export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;
