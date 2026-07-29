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

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevelSchema>;

// Local time of day as "HH:MM", or "" to disable whatever it schedules.
const TimeOfDaySchema = z.string().regex(/^$|^([01]?\d|2[0-3]):[0-5]\d$/, 'expected HH:MM, or "" to disable');

export const SettingsSchema = z.object({
  viewer_rendition_mode: ViewerRenditionModeSchema,
  // What 'remember' remembers. Null until something has been chosen, which is
  // why that mode falls back to the library's own rendition rather than building
  // one nobody asked for.
  last_viewer_rendition: ViewerRenditionSchema.nullable(),

  // `debug` adds a line per HTTP request and per finished processing stage;
  // everything an operator normally wants (imports, batches, failures) is `info`.
  log_level: LogLevelSchema,
  // The web client is a separate app on its own origin, so the API must opt it
  // in. Empty means "any port on whatever host this request reached the API by",
  // which covers serving the client over loopback or the LAN without hardcoding
  // an address. A comma-separated list, or '*', overrides it.
  cors_origins: z.string(),

  // Filesystem watching: auto-sync a library when its files change on disk.
  watch_enabled: z.boolean(),
  watch_debounce_ms: z.number().int().min(0),
  // Daily full reconcile: the backstop that catches changes the watcher's
  // (scoped, lossy-event-driven) syncs missed; dropped events, cross-dir moves,
  // edits made while the server was down. A full scan holds the library mutex,
  // so the default is overnight, out of the way.
  full_sync_at: TimeOfDaySchema,
  // Sweep for generated files whose photo no longer exists (§10.6). Weekly
  // because it only has anything to do after a library is removed or a
  // catalogue is rebuilt, and it reads every rendition directory. 0 disables.
  prune_every_days: z.number().int().min(0),

  processing_concurrency: z.number().int().min(1),
  // Give a render the camera's own colour treatment, by fitting the transform that
  // takes it to the JPEG embedded in the same RAW (`jpeg_match.ts`). Applies to SDR
  // renditions built from a render: an embedded-sourced grid already has the look,
  // and an 8-bit SDR JPEG cannot teach the HDR path what to do above diffuse white.
  //
  // On by default: a render that does not look like the camera's own JPEG is the
  // wrong picture, and the cost is a fraction of the decode it rides along with.
  // Turn it off for an import where throughput matters more.
  match_embedded_jpeg: z.boolean(),
  grid_rendition_size: z.number().int().min(1),
  full_rendition_size: z.number().int().min(1),
  // AVIF quality, which is not WebP's scale: on a 24MP frame the full-size
  // rendition is 375 kB at q60 against 1019 kB for the WebP q90 it replaces, and
  // q90 here would be 2551 kB. The full rendition is the one actually looked at,
  // so it gets the headroom.
  // q60 and q70 visibly lose shadow detail on real frames, which is where a RAW
  // has the most to give. q80 is 1361 kB on a 24MP frame against the 1019 kB of
  // the WebP q90 it replaces, and encodes in 713ms at effort 0.
  grid_rendition_quality: z.number().int().min(1).max(100),
  full_rendition_quality: z.number().int().min(1).max(100),

  // Full-resolution export (§10.5), AVIF. `quality` is libvips' 1-100 scale for
  // the SDR path; `quantizer` is avifenc's 0-63 (lower is better) for the HDR
  // one. Both are set tight rather than "visually lossless", because this is the
  // view that exists to be pixel-peeped, and kept inside a ~20MB budget on a
  // 60MP frame.
  lossless_quality: z.number().int().min(1).max(100),
  lossless_quantizer: z.number().int().min(0).max(63),

  // Display peak the BT.2390 roll-off targets, and what the file declares as its
  // mastering peak. No longer the exposure control: the grade anchors diffuse
  // white independently, so this only sets how much headroom sits above it.
  hdr_peak_nits: z.number().min(1),
  // ITU-R BT.2408 HDR Reference White, and the quantile of the frame taken to be
  // diffuse white. Between them these decide how bright a photo renders, so they
  // are the pair to reach for if a library comes out consistently dark or hot.
  //
  // A lower quantile renders *brighter*: it places diffuse white further down the
  // histogram, so everything above it scales up. 0.99 was too high on a landscape
  // - half sky means the brightest 1% is sky and speculars rather than a lit white
  // surface - and capped a daylight frame at 470 nits with its greenery at 40.
  // 0.90 puts the same frame's peak at 823 and its greenery at 70.
  hdr_reference_white_nits: z.number().min(1),
  hdr_white_quantile: z.number().min(0).max(1),
  // libaom's quantizer and speed, for both HDR media. A still is looked at rather
  // than streamed, so this is tighter than a video default.
  //
  // One scale, and it used to only look like one: the still went to avifenc, whose
  // `--max` is libaom's quantizer, while the video went to SVT-AV1, whose `-crf` is
  // its own - so the same number meant two different qualities, and the comment here
  // named only the second. Both media are libaom now (§10.7), so it means one thing.
  // `preset` is clamped per encoder rather than narrowed to the tighter of the two:
  // avifenc's `--speed` takes 0-10, libaom's `-cpu-used` stops at 8.
  hdr_crf: z.number().int().min(0).max(63),
  hdr_preset: z.number().int().min(0).max(10),
  // A judging size, not a capability limit. It was both while the video went
  // through SVT-AV1, which refuses a frame taller than 8704 rows; libaom takes a
  // 60MP one in either orientation, so what is left is the reason that always
  // mattered - this still is for judging HDR on a monitor rather than for
  // pixel-peeping, which the lossless export already covers, and 4K shows 1:1 on
  // the displays that do HDR.
  hdr_max_edge: z.number().int().min(1),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  viewer_rendition_mode: 'remember',
  last_viewer_rendition: null,

  log_level: 'info',
  cors_origins: '',

  watch_enabled: true,
  watch_debounce_ms: 2000,
  full_sync_at: '03:00',
  prune_every_days: 7,

  processing_concurrency: 4,
  match_embedded_jpeg: true,
  grid_rendition_size: 800,
  full_rendition_size: 3840,
  grid_rendition_quality: 80,
  full_rendition_quality: 80,

  lossless_quality: 88,
  lossless_quantizer: 8,

  hdr_peak_nits: 1000,
  hdr_reference_white_nits: 203,
  hdr_white_quantile: 0.9,
  hdr_crf: 20,
  hdr_preset: 8,
  hdr_max_edge: 3840,
};

export const UpdateSettingsRequestSchema = SettingsSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
