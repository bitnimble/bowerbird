import { z } from 'zod';
import { PhotoIdListSchema, IdSchema } from './common';

// Whether detection still manages a stack. A human touching one - creating it,
// removing a photo, unstacking - makes it 'manual', and detection leaves it
// alone from then on (§19.4.4).
export const StackOriginSchema = z.enum(['auto', 'manual']);
export type StackOrigin = z.infer<typeof StackOriginSchema>;

// Whether a photo is in a stack, and whether detection may put it in one.
// 'unstacked' is the answer that has to be remembered: it means a human already
// pulled this photo out, so re-running detection must not simply put it back.
export const StackStateSchema = z.enum(['none', 'stacked', 'unstacked']);
export type StackState = z.infer<typeof StackStateSchema>;

export const StackSchema = z.object({
  id: IdSchema,
  library_id: IdSchema,
  origin: StackOriginSchema,
  date_created: z.string(),
  photo_count: z.number().int(),
});
export type Stack = z.infer<typeof StackSchema>;

export const CreateStackRequestSchema = PhotoIdListSchema;

// Members are returned whole, and the client decides what to dim: a shoot shows
// every member with the outsiders overlaid, which it can tell from each row's
// own `shoot_id`. An album is strict, so it passes its id and the members are
// filtered to what the album actually holds.
export const StackPhotosQuerySchema = z.object({
  album_id: IdSchema.optional(),
  // Which side of the bin to answer for, so a band agrees with the listing it
  // was opened from. The Bin lists nothing but deleted rows, and a band there
  // showing the live members would be photographs that are not in the Bin.
  deleted: z.stringbool().default(false),
});
