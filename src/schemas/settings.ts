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
  // What every rendered RAW gets before any rendition is cut from it (§10.9). Both
  // are off when 0, and neither touches a rendition made from the camera's own JPEG:
  // that one arrives denoised and sharpened by the body already.
  //
  // `raw_denoise` is a strength, 1 being the tuned default and 0 off. It drives two
  // guided filters: one on luma, regularised by the frame's **own measured noise**, and
  // one on chroma guided by that cleaned luma. Colour noise is blotchy and takes a wide
  // radius; luma noise is per-pixel grain and takes a narrow one, and guiding the colour
  // by the luma is what lets its radius grow without washing a red wall onto the white
  // window frames beside it.
  //
  // **No ISO scaling, because the noise is measured rather than predicted.** It was
  // scaled by ISO first, and measurement answers the same question better: by the time
  // this runs the frame has been demosaiced, resampled - which averages some of the
  // noise away - and graded, possibly by several stops, and none of that is in the ISO.
  //
  // `raw_sharpen` blends in a **Richardson-Lucy deconvolution** of luma, applied last,
  // once the frame is at the size it will be encoded at. An unsharp mask has no model of
  // what softened the picture and gets its halo from the overshoot it leaves; this one
  // inverts the point spread the resample applied, so 1.0 is the deconvolution as
  // computed rather than an arbitrary gain. Denoising first is not optional - RL will
  // invert grain as readily as blur.
  //
  // **The denoise is tuned short of what the metric would pick**, on purpose: the luma
  // side is set where a dark roof keeps its texture rather than where flat water is
  // quietest, because grain reads as a photograph and smearing reads as a fault. Raise it
  // above about 1.5 and the second starts happening.
  //
  // The default is half of what that tuning landed on, which is a judgement about fur
  // and foliage rather than about the metric: at 1 the frames this was checked against
  // lose the fine structure that makes them read as photographs, and what the colour fit
  // needs from a denoise it already has at 0.5.
  //
  // Two earlier versions are worth not repeating. LibRaw's wavelet denoise on the CFA had
  // the better position in the pipeline and could not be made to work at any setting; and
  // a chroma-only Gaussian blur, which fixed the colour mottle and left the luma grain
  // that is most of what the eye objects to (§10.9).
  raw_denoise: z.number().min(0).max(3),
  raw_sharpen: z.number().min(0).max(1),

  grid_rendition_size: z.number().int().min(1),
  full_rendition_size: z.number().int().min(1),
  // libaom's quantizer, 0-63, **lower is better** - the same scale as the HDR ones
  // below, because every AVIF this app writes now goes through libavif (§10.7).
  //
  // These were libvips' 1-100 quality, where higher was better, until the SDR
  // encoder moved off libheif. The numbers here are the measured equivalents of what
  // was tuned on that scale rather than a fresh guess: matched on SSIM against the
  // frames the old values were chosen on, Q80 lands on 13 and Q88 on 8, both within
  // 0.0002 SSIM and half a percent of file size. **The direction inverted**, so a
  // value carried over from the old scale reads as its opposite - 80 here is not
  // "good", it is nearly the worst this will produce.
  //
  // Those two were written down as 26 and 16, which is twice what they encode at:
  // libavif was handed `min 0 / max N` and quantises on the midpoint, so every
  // number here meant half itself. The encoder gets both ends now and the values are
  // halved to match, which leaves every file byte-identical (§10.7).
  //
  // The reasoning behind the original choice still applies: the full rendition is
  // the one actually looked at, so it gets the headroom, and the settings that lose
  // visible shadow detail on real frames - the old q60 and q70, which are 26 and 19
  // here - are where a RAW has the most to give and are worth avoiding.
  grid_rendition_quantizer: z.number().int().min(0).max(63),
  full_rendition_quantizer: z.number().int().min(0).max(63),

  // Full-resolution export (§10.5), AVIF. Two numbers because the two paths land at
  // different depths and chroma - 8-bit 4:4:4 for SDR, 10-bit for HDR - so the same
  // quantizer does not buy the same picture. Both are set tight rather than
  // "visually lossless", because this is the view that exists to be pixel-peeped,
  // and kept inside a ~20MB budget on a 60MP frame.
  lossless_sdr_quantizer: z.number().int().min(0).max(63),
  // Chroma for the SDR renditions, the same trade as `hdr_still_full_chroma` and
  // separate from it because the numbers are not the same size. Measured on a 24MP
  // frame: the viewer rendition encodes in 224ms against 483ms and lands at 0.53MB
  // against 1.72MB, and the native-resolution one peaks at 651MB against 918MB. The
  // grid tile is where it costs least of all - 15% smaller for an SSIM difference of
  // 0.0008 - and that is the rendition every photo gets (§10.1).
  sdr_full_chroma: z.boolean(),
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
  // One scale, twice claimed and only now true. The still went to avifenc, whose
  // `--max` is libaom's quantizer, while the video went to SVT-AV1, whose `-crf` is
  // its own; moving both to libaom was supposed to settle it, and did not, because
  // libavif was still being handed `min 0 / max N` and quantises on the *midpoint* -
  // so the still encoded at half this number and the video at all of it. The video
  // was the visible half: blocking, chroma loss and noise on an HDR display in
  // Firefox, where the still beside it was clean (§10.7).
  // `preset` is clamped per encoder rather than narrowed to the tighter of the two:
  // avifenc's `--speed` takes 0-10, libaom's `-cpu-used` stops at 8.
  hdr_crf: z.number().int().min(0).max(63),
  hdr_preset: z.number().int().min(0).max(10),
  // Chroma for the HDR still. Off means 4:2:0, which is the default and a memory
  // decision rather than a quality one: it halves what libaom carries, and the
  // encoder is the peak. Measured on a 24MP frame, native resolution, 960MB against
  // 586MB. It is worse per byte on a photograph - held to equal SSIM it wants 51%
  // more of them - so this is here for a library that would rather spend the memory
  // than the bitrate (§10.7). The video has no say: 4:4:4 video is AV1 Profile 1,
  // which Chromium refuses and no hardware decodes.
  hdr_still_full_chroma: z.boolean(),
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
  raw_denoise: 0.5,
  raw_sharpen: 0.6,
  grid_rendition_size: 800,
  full_rendition_size: 3840,
  grid_rendition_quantizer: 13,
  full_rendition_quantizer: 13,

  lossless_sdr_quantizer: 8,
  lossless_quantizer: 4,

  hdr_peak_nits: 1000,
  hdr_reference_white_nits: 203,
  hdr_white_quantile: 0.9,
  hdr_crf: 10,
  hdr_preset: 8,
  hdr_still_full_chroma: false,
  sdr_full_chroma: false,
};

export const UpdateSettingsRequestSchema = SettingsSchema.partial();
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
