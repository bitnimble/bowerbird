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

// Which of them the viewer opens a photo at. The first three pin it; the next
// two follow whatever was chosen last, either across the catalogue or for the
// photo being opened. `best_available` takes the highest of them already on
// disk, so it never costs a build - the camera's JPEG where nothing is.
export const ViewerRenditionModeSchema = z.enum(['embedded', 'full', 'max', 'remember', 'remember_per_photo', 'best_available']);
export type ViewerRenditionMode = z.infer<typeof ViewerRenditionModeSchema>;

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = z.infer<typeof LogLevelSchema>;

// Local time of day as "HH:MM", or "" to disable whatever it schedules.
const TimeOfDaySchema = z.string().regex(/^$|^([01]?\d|2[0-3]):[0-5]\d$/, 'expected HH:MM, or "" to disable');

export const SettingsSchema = z.object({
  viewer_rendition_mode: ViewerRenditionModeSchema.default('remember'),
  // What 'remember' remembers. Null until something has been chosen, which is
  // why that mode falls back to the library's own rendition rather than building
  // one nobody asked for.
  last_viewer_rendition: ViewerRenditionSchema.nullable().default(null),
  // Collapse the sidebar while a photo is open, and put it back on the way out -
  // unless it was already collapsed, which is a preference rather than something
  // the viewer did.
  hide_sidebar_in_viewer: z.boolean().default(true),
  // Off until asked for: turning it on has the server search the local network for TVs.
  frame_tv_enabled: z.boolean().default(false),
  onboarding_complete: z.boolean().default(false),

  // `debug` adds a line per HTTP request and per finished processing stage;
  // everything an operator normally wants (imports, batches, failures) is `info`.
  log_level: LogLevelSchema.default('info'),
  // The web client is a separate app on its own origin, so the API must opt it
  // in. Empty means "any port on whatever host this request reached the API by",
  // which covers serving the client over loopback or the LAN without hardcoding
  // an address. A comma-separated list, or '*', overrides it.
  cors_origins: z.string().default(''),

  // Filesystem watching: auto-sync a library when its files change on disk.
  watch_enabled: z.boolean().default(true),
  watch_debounce_ms: z.number().int().min(0).default(15000),
  // How often a library that cannot be watched is walked for folders whose mtime
  // moved (§9.8). Applies to a library on a network filesystem and to nothing
  // else: a change made by another machine never reaches this kernel, so there is
  // no event to wait for. A pass stats one folder rather than one photograph, so
  // this can be short - 68ms over a 30,000-file library on NFS - but the mount's
  // own attribute cache is the floor on how fresh what it reads can be, and that
  // is a minute at the usual `acdirmax`.
  watch_poll_interval_ms: z.number().int().min(1000).default(20000),
  // Daily full reconcile: the backstop that catches changes the watcher's
  // (scoped, lossy-event-driven) syncs missed; dropped events, cross-dir moves,
  // edits made while the server was down. It is also the only run that walks the
  // bin (§9.1.1), the watcher not watching it, so turning this off gives up
  // reconciling the Bin rather than merely delaying it. A full scan holds the
  // library mutex, so the default is overnight, out of the way.
  full_sync_at: TimeOfDaySchema.default('03:00'),
  // Sweep for generated files whose photo no longer exists (§10.6). Weekly
  // because it only has anything to do after a library is removed or a
  // catalogue is rebuilt, and it reads every rendition directory. 0 disables.
  prune_every_days: z.number().int().min(0).default(7),
  // Rolling snapshot of the catalogue (§4.9). 0 disables; `backup_keep` is a
  // count of files rather than of days, so lengthening the interval does not
  // silently shorten the window it covers.
  backup_every_days: z.number().int().min(0).default(1),
  backup_keep: z.number().int().min(1).default(7),
  // How many exported files the history keeps (§10.5.2). Counted in files rather than in
  // runs, since what it is really bounding is the thumbnail beside each one; whole runs are
  // what leaves, so the count is a floor rather than a ceiling.
  export_history_limit: z.number().int().min(1).default(1000),

  processing_concurrency: z.number().int().min(1).default(4),
  // How many files a scan reads the headers of at once. Its own number rather than
  // `processing_concurrency`'s, because the two are limited by different things: a
  // rendition worker holds a whole RAW and is bound by memory and the GPU, while a
  // scan worker reads a few hundred KB of tags and is bound by how many reads the
  // disk will answer at once - which for a library on a network mount is many.
  scan_concurrency: z.number().int().min(1).default(4),
  // Give a render the camera's own colour treatment, by fitting the transform that
  // takes it to the JPEG embedded in the same RAW (`native/rawshim/src/fit.rs`). Applies to SDR
  // renditions built from a render: an embedded-sourced grid already has the look,
  // and an 8-bit SDR JPEG cannot teach the HDR path what to do above diffuse white.
  //
  // On by default: a render that does not look like the camera's own JPEG is the
  // wrong picture, and the cost is a fraction of the decode it rides along with.
  // Turn it off for an import where throughput matters more.
  match_embedded_jpeg: z.boolean().default(true),
  // What every rendered RAW gets before any rendition is cut from it (§10.9). Off when 0,
  // and it does not touch a rendition made from the camera's own JPEG: that one arrives
  // corrected by the body already.
  //
  // **The denoise and the sharpen are not here.** They belong to the photograph rather than
  // to the library - a frame at 12800 and one at base ISO want different answers, and a
  // single setting could only ever be right for one of them - so they live in the edit
  // document as the Detail panel's sliders.
  //
  // A **ceiling** on the colour fringe correction, not the amount of it (§10.8).
  //
  // **The aberration the warp cannot reach.** Lateral CA is a magnification difference and
  // comes out in the resample; this is the other one, where the lens focuses red, green and
  // blue at different distances, so at a hard edge one channel is sharp and another is not.
  // The channels are registered - nothing has moved - and one is simply blurrier.
  //
  // Which makes the fringe the *Laplacian of luma* times one coefficient, and that
  // coefficient is fitted per frame, so 1 applies the correction the frame was measured to
  // need rather than an arbitrary strength.
  //
  // It replaced a plain strength over a stage that pulled colour towards a box mean
  // wherever the luma gradient was steep. That had no model of the defect - a thin
  // saturated object looks exactly like a fringe to a gradient - so it greyed out street
  // lamps, and the setting was the only thing bounding it.
  //
  // Both confounds review found are fixed and pinned by tests, so this defaults to 1.
  //
  // *Per-channel noise.* The regressor and the response are built from the same pixels, and
  // green's noise enters one with +0.7152 and the other with -0.7152, so they were
  // correlated by construction. The residue was positive for both channels, which cleared
  // the sign veto, and being a ratio of variances it did not shrink as the noise did: a
  // flat frame with independent grain fitted (0.124, 0.175) - that blue figure larger than
  // the 0.148 measured on the library's worst real frame. Both sums' noise term has a
  // closed form, so `measure_defocus` subtracts it. After: the noise-only frame returns
  // nothing, and a real 0.12 defocus reads 0.0926 clean against 0.0928 with grain on top.
  //
  // *Lateral aberration.* A channel displaced by `d` expands as `G + d.grad G +
  // (d^2/2).lap G`, and that second term is the basis this fit regresses on. It carries
  // `d^2`, so it is positive for red and blue whichever way each is displaced - precisely
  // what the sign veto cannot catch, since that veto rejects things that flip sign. A pure
  // lateral aberration with nothing out of focus anywhere fitted (0.054, 0.053), and the
  // correction was then applied at every radius including the centre, where a magnification
  // difference displaces nothing. `d` grows with `r`, so the confound's apparent
  // coefficient grows with `r^2` where a real focus difference is flat across the field:
  // the fit is taken per radial bin and split into a constant plus an `r^2` term, keeping
  // only the constant. The confound now measures nothing, and a real focus difference
  // survives a lateral one laid on top of it.
  //
  // Measured over 215 frames from 104 shoots, scored as deltaE76 against each camera's own
  // JPEG over the pixels the stage moves. Nothing is harmed by more than a JND at any
  // strength - worst frame +0.26 at full - and four frames are helped by more than one,
  // best -2.83. Mean improvement is 40% larger at 1 than at 0.5, and the large wins appear
  // only there. It fires on 37 of 215 frames: the confounds are what made the version
  // before this one fire on 143.
  raw_defringe: z.number().min(0).max(1).default(1),

  grid_rendition_size: z.number().int().min(1).default(800),
  full_rendition_size: z.number().int().min(1).default(3840),
  // The same rendition of a panorama, which is a different picture at the same number of
  // pixels: a canvas is several frames wide, so 3840 on its longest edge leaves each frame
  // with a few hundred and the viewer showing a blur the moment anybody zooms. Its own
  // setting rather than a multiplier, because how wide a canvas is depends on how far the
  // photographer panned and not on anything a library can know.
  //
  // A panorama's grid tile takes `grid_rendition_size` times `PANORAMA_TILE_SCALE` for the
  // same reason and has no setting: a tile is a thumbnail either way, and one number for
  // the wall of them is what keeps them a wall.
  panorama_full_rendition_size: z.number().int().min(1).default(16384),
  // Perceived quality, 0-100 and higher is better, which `processing/quality.ts` turns
  // into whatever the encoder for this rendition counts in. One number per rendition
  // rather than an SDR one and an HDR one: the same picture needs a far tighter
  // quantizer in PQ than in sRGB (§10.7), and which is which is the mapping's business
  // rather than the reader's.
  //
  // The full rendition is the one actually looked at, so it gets the headroom. The
  // settings that lose visible shadow detail on real frames sit around 60 here, which is
  // where a RAW has the most to give and is worth avoiding.
  grid_rendition_quality: z.number().int().min(0).max(100).default(80),
  full_rendition_quality: z.number().int().min(0).max(100).default(80),

  // The native-resolution rendition (§10.5). Set tighter than the viewing sizes rather
  // than "visually lossless", because this is the view that exists to be pixel-peeped,
  // and kept inside a ~20MB budget on a 60MP frame.
  max_rendition_quality: z.number().int().min(0).max(100).default(88),
  // Chroma for the SDR renditions, the same trade as `hdr_still_full_chroma` and
  // separate from it because the numbers are not the same size. Measured on a 24MP
  // frame: the viewer rendition encodes in 224ms against 483ms and lands at 0.53MB
  // against 1.72MB, and the native-resolution one peaks at 651MB against 918MB. The
  // grid tile is where it costs least of all - 15% smaller for an SSIM difference of
  // 0.0008 - and that is the rendition every photo gets (§10.1).
  sdr_full_chroma: z.boolean().default(false),

  // Display peak the BT.2390 roll-off targets, and what the file declares as its
  // mastering peak. No longer the exposure control: the grade anchors diffuse
  // white independently, so this only sets how much headroom sits above it.
  hdr_peak_nits: z.number().min(1).default(1000),
  // ITU-R BT.2408 HDR Reference White, and the quantile of the frame taken to be
  // diffuse white. Between them these decide how bright a photo renders, so they
  // are the pair to reach for if a library comes out consistently dark or hot.
  //
  // A lower quantile renders *brighter*: it places diffuse white further down the
  // histogram, so everything above it scales up. 0.99 was too high on a landscape
  // - half sky means the brightest 1% is sky and speculars rather than a lit white
  // surface - and capped a daylight frame at 470 nits with its greenery at 40.
  // 0.90 puts the same frame's peak at 823 and its greenery at 70.
  hdr_reference_white_nits: z.number().min(1).default(203),
  hdr_white_quantile: z.number().min(0).max(1).default(0.9),
  // libavif's encoder speed, 0 slowest and 10 fastest.
  avif_speed: z.number().int().min(0).max(10).default(8),
  // Chroma for the HDR still. On is 4:4:4 for every still. Off, the default, is 4:2:0
  // unless the frame itself says a 4:2:0 decode would come back wrong - measured before
  // the encode, per rendition, by `chroma_leak.slang` - in which case that still is
  // 4:4:4 on its own (§10.1). A memory decision rather than a quality one where it
  // holds: 4:2:0 halves what libaom carries, and the encoder is the peak. Measured on
  // a 24MP frame, native resolution, 960MB against 586MB. It is worse per byte on a
  // photograph - held to equal SSIM it wants 51% more of them - so this is here for a
  // library that would rather spend the memory than the bitrate. The video has no
  // say: 4:4:4 video is AV1 Profile 1, which Chromium refuses and no hardware decodes.
  hdr_still_full_chroma: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;

// Derived from the schema's `.default()`s - the single source of shipped values.
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

// Zod's `.partial()` still applies field defaults for omitted keys, which would
// turn a one-field PATCH into a reset of everything else. Strip defaults first.
type WithoutDefaults<S extends z.ZodRawShape> = {
  [K in keyof S]: z.ZodOptional<S[K] extends z.ZodDefault<infer Inner> ? Inner : S[K]>;
};

function optionalWithoutDefaults<S extends z.ZodRawShape>(shape: S): WithoutDefaults<S> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      z.optional(field instanceof z.ZodDefault ? field.removeDefault() : field),
    ]),
  ) as WithoutDefaults<S>;
}

export const UpdateSettingsRequestSchema = z.object(optionalWithoutDefaults(SettingsSchema.shape));
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
