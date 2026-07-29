import { z } from 'zod';

// The renditions the viewer offers, in quality order, and what the UI names
// "Rendition". `full` and `max` are stored renditions (§10.2) - a demosaiced
// render fitted to the viewer's size, and one at native resolution. `embedded`
// is one only to the reader choosing between them: it is the camera's own JPEG,
// served straight out of the RAW rather than resized into HDR or transcoded into
// AVIF and cached as a file of its own.
export const VIEWER_RENDITIONS = ['embedded', 'full', 'max'] as const;
export const ViewerRenditionSchema = z.enum(VIEWER_RENDITIONS);
export type ViewerRendition = z.infer<typeof ViewerRenditionSchema>;

// Which of them the viewer opens a photo at. The first three pin it; the last
// two follow whatever was chosen last, either across the catalogue or for the
// photo being opened.
export const ViewerRenditionModeSchema = z.enum(['embedded', 'full', 'max', 'remember', 'remember_per_photo']);
export type ViewerRenditionMode = z.infer<typeof ViewerRenditionModeSchema>;

export const SettingsSchema = z.object({
  viewer_rendition_mode: ViewerRenditionModeSchema,
  // What 'remember' remembers. Null until something has been chosen, which is
  // why that mode falls back to the library's own rendition rather than building
  // one nobody asked for.
  last_viewer_rendition: ViewerRenditionSchema.nullable(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const UpdateSettingsRequestSchema = SettingsSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
