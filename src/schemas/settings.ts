import { z } from 'zod';

// What the viewer can show, in quality order. `full` and `max` are renditions in
// the storage sense (§10.2) - a demosaiced render fitted to the preview size, and
// one at native resolution. `embedded` is not: it is the camera's own JPEG,
// served straight out of the RAW rather than resized into HDR or transcoded into
// AVIF and cached as a rendition of its own.
export const PREVIEW_RENDITIONS = ['embedded', 'full', 'max'] as const;
export const PreviewRenditionSchema = z.enum(PREVIEW_RENDITIONS);
export type PreviewRendition = z.infer<typeof PreviewRenditionSchema>;

// Which of them the viewer opens a photo at. The first three pin it; the last
// two follow whatever was chosen last, either across the catalogue or for the
// photo being opened.
export const PreviewRenditionModeSchema = z.enum(['embedded', 'full', 'max', 'remember', 'remember_per_photo']);
export type PreviewRenditionMode = z.infer<typeof PreviewRenditionModeSchema>;

export const SettingsSchema = z.object({
  preview_rendition_mode: PreviewRenditionModeSchema,
  // What 'remember' remembers. Null until something has been chosen, which is
  // why that mode falls back to the photo's own thumbnail rather than building
  // a rendition nobody asked for.
  last_preview_rendition: PreviewRenditionSchema.nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const UpdateSettingsRequestSchema = SettingsSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
