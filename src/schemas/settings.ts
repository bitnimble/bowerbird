import { z } from 'zod';

// The renditions of one photo, in quality order. Each is the same picture at a
// different cost: the camera's own JPEG, a demosaiced render fitted to the
// preview size, and a full-resolution render (§10.5).
export const PREVIEW_RENDITIONS = ['embedded', 'render', 'max'] as const;
export const PreviewRenditionSchema = z.enum(PREVIEW_RENDITIONS);
export type PreviewRendition = z.infer<typeof PreviewRenditionSchema>;

// Which of them the viewer opens a photo at. The first three pin it; the last
// two follow whatever was chosen last, either across the catalogue or for the
// photo being opened.
export const PreviewRenditionModeSchema = z.enum(['embedded', 'render', 'max', 'remember', 'remember_per_photo']);
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
