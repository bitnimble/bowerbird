import { z } from 'zod';
import { OrderingSchema, PhotoIdListSchema, IdSchema } from './common';

// Whether detection still manages a stack. A human touching one - creating it,
// removing a photo, unstacking - makes it 'manual', and detection leaves it
// alone from then on (§19.4.4). 'bracket' is a capture the camera ran as one,
// grouped off the frames' own metadata rather than their likeness.
export const StackOriginSchema = z.enum(['auto', 'manual', 'bracket']);
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

export const UnstackedCountSchema = z.object({ unstacked: z.number().int() });
export type UnstackedCount = z.infer<typeof UnstackedCountSchema>;

export const CreateStackRequestSchema = PhotoIdListSchema;

// Members are returned whole, and the client decides what to dim: a shoot shows
// every member with the outsiders overlaid, which it can tell from each row's
// own `shoot_id`. An album is strict, so it passes its id and the members are
// filtered to what the album actually holds.
export const StackPhotosQuerySchema = z.object({
  album_id: IdSchema.optional(),
  // The shoot the band was opened in, which narrows nothing and exempts one thing: a hidden shoot
  // does not hide its own photographs from its own page, so a band there has to hold the members
  // that page's tile counted (§12.4). Every other hidden shoot still hides, so a stack straddling
  // one shows here exactly the half this shoot holds.
  shoot_id: IdSchema.optional(),
  // Which side of the bin to answer for, so a band agrees with the listing it
  // was opened from. The Bin lists nothing but deleted rows, and a band there
  // showing the live members would be photographs that are not in the Bin.
  deleted: z.stringbool().default(false),
  // The sort of the collection the band is drawn in, which the viewer also steps
  // through: a shoot and an album each carry one of their own, so the library's
  // is not an answer either.
  //
  // Required, and with no default. A default is a sort this route picks for a
  // caller that did not think about it, which is the same thing as the hardcoded
  // one that had a band listed in an order the viewer does not step in - moved
  // one layer up and made harder to see.
  ordering: OrderingSchema,
});
