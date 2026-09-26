import { z } from 'zod';
import { IdSchema } from './common';

export const LABEL_NAME_MAX = 20;

export const LabelNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(LABEL_NAME_MAX)
  .regex(/^[^\r\n]*$/, 'a label is one line');

export const LabelColourSchema = z.string().regex(/^#[0-9a-f]{6}$/);

export const LabelSchema = z.object({
  id: IdSchema,
  library_id: IdSchema,
  name: z.string(),
  colour: z.string(),
  position: z.number().int(),
  photo_count: z.number().int(),
});
export type Label = z.infer<typeof LabelSchema>;

export const LabelListSchema = z.array(LabelSchema);

export const CreateLabelRequestSchema = z.object({
  library_id: IdSchema,
  name: LabelNameSchema,
  colour: LabelColourSchema,
});
export type CreateLabelRequest = z.infer<typeof CreateLabelRequestSchema>;

// The edit dialog's whole list at once, in the order it shows. Labels it never mentions keep their
// place after these rather than being taken as deleted: another device may have added one since the
// dialog opened, and only `removed` says a label is meant to go. A name or colour is sent only where
// the reader changed it, since the dialog's copy of the rest may be older than a rename that has
// replicated in since.
export const SaveLabelsRequestSchema = z.object({
  library_id: IdSchema,
  labels: z
    .array(
      z
        .object({ id: IdSchema.optional(), name: LabelNameSchema.optional(), colour: LabelColourSchema.optional() })
        .refine((label) => label.id != null || (label.name != null && label.colour != null), {
          message: 'a new label needs a name and a colour',
        }),
    )
    .max(1000),
  removed: z.array(IdSchema).max(1000),
});
export type SaveLabelsRequest = z.infer<typeof SaveLabelsRequestSchema>;
