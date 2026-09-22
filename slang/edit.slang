// What every pass is told about the frame and the edit.
//
// One layout for all of them so a pass can be added without a second uniform to keep in
// step. `std140`-ish by hand: everything is 4 bytes and the two-component members are
// placed where 8-byte alignment already holds. `gpu::uniform_words` writes it, field for field,
// in this order, and `the_uniform_matches_the_shader_struct` parses this struct to hold it there.
// Named apart from the uniform it declares: a module and a variable of one name are ambiguous
// wherever both are in scope, and it is the variable every importer spells.
module edit_uniform;

public struct Edit {
    public uint width;
    public uint height;
    // `tone::Levels` divided by the exposure, which is how the grade moves the anchor
    // rather than the pixels (`tone::grade`).
    public float white;
    public float source_level;
    public float reference;
    public float peak;
    /// The photographer's exposure **in stops**, which is the unit `EditDoc` stores.
    ///
    /// Stops rather than a `2^EV` gain for each host to convert it into. That conversion
    /// is a rule, and a rule each host applies is a rule each host can get wrong - a guard
    /// refusing a non-positive gain exists precisely because "a caller sent stops where
    /// a multiplier belongs" is a reachable mistake. Carrying the document's own unit and
    /// raising it here makes both the conversion and the guard unnecessary.
    public float exposure;
    /// Which transfer `encode` writes: 0 is PQ at 16 bits, 1 is sRGB at 8.
    ///
    /// This is the whole of what SDR means to the pipeline. The grade is the same either way
    /// - `job::peak_nits` puts an SDR target's peak at diffuse white, so its highlights roll
    /// into white through the same BT.2390 curve rather than clipping - and the two diverge
    /// only here, at the primaries and the transfer. A second entry point would have been a
    /// second copy of the grade to keep in step.
    ///
    /// It took the spare word this struct already carried, so no offset moved.
    public uint output;
    public uint matched;
    public float saturation;
    public uint has_chroma;
    public uint curve_bins;
    public float trust_ceiling;
    public uint chroma_count;
    public uint level_count;
    public float chroma_low;
    public float chroma_scale;
    public float chroma_low_by;
    public float chroma_scale_by;
    public float level_scale;
    public float sdr_white;
    /// Rows apart the peak's quantile samples, so it reads about a million pixels.
    public uint row_stride;
    /// How many the open sampled, which is the population the quantile's rank is over.
    public uint peak_samples;
    /// The part of the frame on screen, in source pixels, and the canvas showing it.
    public float2 region_origin;
    public float2 region_size;
    public float2 canvas_size;
    /// The coarsest mip the frame has, which is how far out the draw can average.
    public uint max_lod;
    /// Which operator the print fits highlights into paper with (`print_signal`). It took the
    /// spare word this struct already carried, so no offset moved.
    public uint print_tone;

    /// The photographer's own adjustments, on Camera Raw's -100..100 scales
    /// (`EditDocSchema`). Zero is no change, which is what an unedited photo carries.
    ///
    /// Appended after `pad` rather than placed among the scalars above: everything from
    /// `region_origin` on is `float2`, and the layout puts those on a multiple of eight, so
    /// inserting a scalar earlier moves every field after it and the binding comes back
    /// rejected. Growing the tail moves nothing.
    ///
    /// `sat_adjust` rather than `saturation`, which is taken - that one is the camera
    /// match's own fit multiplier around 1.0 and not a slider anybody moves.
    public float contrast;
    public float highlights;
    public float shadows;
    public float whites;
    public float blacks;
    public float vibrance;
    public float sat_adjust;

    /// The presence three, which read `detail`'s blur rather than the pixel alone.
    ///
    /// `texture_adjust` rather than `texture`, in the same spirit as `sat_adjust` above: a
    /// member called `texture` beside a file full of `Texture2D` and `SampleLevel` reads as a
    /// type wherever it appears.
    public float texture_adjust;
    public float clarity;
    public float dehaze;

    /// The illuminant the camera balanced this frame for, which is the baseline the reader's
    /// pair moves away from (`white_balance`).
    public float as_shot_temperature;
    public float as_shot_tint;
    /// And what the reader asked for, straight off the document.
    ///
    /// **Neither host resolves these; the shader does.** The document holds null for a half the
    /// reader has not moved, and what null means - the frame's own illuminant - is a rule, so
    /// having each host apply it is two implementations of one rule. They were not the same rule:
    /// one stood a missing tint up as the frame's and the other as zero, which is the Planckian
    /// locus, and the rendition came out a different colour from the picture the reader approved.
    /// So the hosts copy the document and `balance_set` says which halves it actually held.
    public float temperature;
    public float tint;
    /// Bit 0 for the temperature, bit 1 for the tint. Zero is "as shot", which is what an
    /// unedited photo carries.
    public uint balance_set;

    /// The reader's crop, as fractions of the *straightened* frame - Camera Raw's definition
    /// and `EditDocSchema`'s. Left, top, right, bottom.
    public float crop_left;
    public float crop_top;
    public float crop_right;
    public float crop_bottom;
    /// The straighten as its cosine and sine, and the quarter turn after it.
    ///
    /// **The host's, in f64, rather than `cos`/`sin` here**: Vulkan holds those to 2^-11 absolute,
    /// which across a 6000-pixel frame is over a pixel, so every adapter straightened to its own
    /// sample positions: SwiftShader's frame sat 57 codes off the hardware's on average.
    public float crop_cos;
    public float crop_sin;
    public uint rotate;
    /// The size of the picture this produces, which is what the region is a window on.
    ///
    /// Sent rather than derived: it is `displaySize` on the client and `hdr::cropped_size`
    /// natively, and the turn's own arithmetic reads the *output* grid's dimensions - so a
    /// shader computing them again would be a third answer to a question two hosts already
    /// agree on.
    public uint output_width;
    public uint output_height;

    /// The perspective correction, row-major, the ninth element dropped because it is always 1.
    ///
    /// Corrected back to source and in fractions of the frame - the direction the draw reads and
    /// the units that mean the same thing at every rendition size.
    ///
    /// Written out as scalars rather than held in an array or a `float3x3`: a uniform array of
    /// scalars is laid out at a sixteen-byte stride, and a matrix as three `float4`, so either
    /// would put holes in the middle of a struct both hosts fill in a flat loop.
    public float keystone_0;
    public float keystone_1;
    public float keystone_2;
    public float keystone_3;
    public float keystone_4;
    public float keystone_5;
    public float keystone_6;
    public float keystone_7;
    /// Whether there is one. Zero is a photograph nobody corrected, which is most of them.
    public uint has_keystone;

    /// The long edge `detail`'s working texture would have for the *whole photograph*.
    ///
    /// **Because a frame can be a piece of one.** The guided filter's window is a fraction of that
    /// long edge, and a host reading it off the texture it allocated would filter a loupe tile at a
    /// fraction of the tile - a twelfth of the scale the export uses, so the same Clarity produces
    /// local contrast the reader cannot find again in the file they get. Equal to the texture's own
    /// long edge for every whole frame, which is every rendition and the editor's own.
    public uint detail_long;

    /// How many of the frame's pixels each of that texture's texels covers.
    ///
    /// The partition is a step rather than a division so that it is the same partition wherever a
    /// window of the photograph starts: a division puts a tile's texel boundaries between the
    /// frame's and averages a different set of pixels into each one.
    public uint detail_step;

    /// The whole corrected photograph, which the crop fractions and the straighten are defined over.
    ///
    /// **Not `width`/`height`, and that is the point.** Those are the *buffer* this dispatch reads,
    /// and a render of a cropped photograph only decodes the part of the picture its crop reaches -
    /// so the frame in memory is a window, while "left 8% of the frame" still means 8% of the
    /// photograph. Equal to `width`/`height` for every whole frame, which is the editor's and every
    /// uncropped rendition.
    public uint photo_width;
    public uint photo_height;

    /// Where that buffer starts in the photograph, in its pixels. Zero for a whole frame.
    ///
    /// Taken off *after* `geometry_at` has computed a position, never folded into the arithmetic
    /// before it: the two are equal exactly and not in `f32`, and the same fold cost `warp` a
    /// whole count on 0.68% of a loupe tile's samples (`Params::centre` there).
    public uint window_left;
    public uint window_top;

    /// The chroma lattice's surround axis, and where to read its thumb.
    ///
    /// A window of its own rather than `window_left`/`photo_width`: a loupe tile applies no
    /// geometry, so those stay zero there, while the thumb is the photograph's and has to be
    /// read in its UV whatever piece of it this frame is.
    public uint surround_count;
    public float surround_scale;
    public uint has_surround;
    public uint surround_left;
    public uint surround_top;
    public uint surround_photo_width;
    public uint surround_photo_height;
    /// Whether a `mean_frame` was built beside the frame, so the lattice can be read at
    /// the neighbourhood the fit taught. Clear only for the probes, which have no frame.
    public uint has_mean;
    /// This frame's pixels to a texel of `mean_frame`, from `gpu::mean_block` - the fit's own
    /// supervision footprint, which is a share of the photograph and so travels like
    /// `chroma_shrink` below rather than being a constant.
    ///
    /// The grid is anchored at the photograph's origin in whole blocks, so a window opens on a
    /// partial one; `colour::cell_at` reads the cells by index off this and the window's origin.
    public uint mean_block;
    /// Whether `chroma_smoothed` holds this frame's matched colour, smoothed, for
    /// `matched_nits` to take its chroma from. Clear for the pass that builds it, and for
    /// the probes.
    public uint has_smoothed;
    /// This frame's pixels to a texel of `chroma_smoothed`, from `gpu::chroma_shrink`.
    ///
    /// Carried rather than a constant because it is a share of the *photograph* and this frame
    /// is a rendition of one: four pixels of a 3840 render and ten of the same photograph at a
    /// 61MP sensor's own size are the same colour footprint, and a fixed four would be the same
    /// footprint only at one output size.
    public uint chroma_shrink;
    /// `hdr_fit::HdrColour::anchor`: where `curves_at` reads a highlight's colour.
    public float tone_anchor;

    /// The picture's own darkest end, as a fraction of diffuse white - `tone::Levels::floor`
    /// over `white`, which is the domain `base_luma` is already in.
    ///
    /// `adjust::low_span` turns it into the share of a photograph's range this frame holds, and
    /// Blacks and Shadows are placed at that share of where they sit on a full one. Zero is a
    /// caller that measured no floor and reads as a picture reaching all the way down, which is
    /// the full share and so the placement every photograph with real black in it gets.
    public float black_floor;
};

[vk::binding(0, 0)] public ConstantBuffer<Edit> edit;

public uint at(uint x, uint y) { return y * edit.width + x; }
