// The demosaiced frame into the camera's colour, cropped, turned upright, and written straight into
// the frame every stage after the decode reads.
//
// **This is where the decode stops crossing the bus.** RCD leaves interleaved `f32` RGB in the
// sensor's own primaries; what a frame is measured and graded in is Rec.2020 `u16`, upright, cropped
// to the readable area. Between them sat a 3x3, a quantise, a stitch and a permutation, all on the
// host - so every tile read back its whole plane, three `f32` a pixel including the halo RCD needed
// either side of it, and the frame was then assembled and rotated in two more passes over host
// memory. Doing it here makes the readback the answer instead, once, for the whole frame.
//
// **Indexed by destination word, not by pixel, and that is the whole design.** Three samples a pixel
// and two samples a word means a tile's destination row rarely begins on a word boundary, so its
// first and last word are half this tile's and half its neighbour's - and once the orientation folds
// in, a source row maps to an output *column*, so one word can hold samples from two different rows
// of the same tile. Owning the word rather than the pixel makes both go away: no two invocations in
// a dispatch touch the same word, whatever the orientation. Where a word straddles the tile's own
// edge the other half is read and put back, which is safe because tiles submit as separate passes
// and the neighbour's write has already landed.
//
// The cost is that a source pixel can be fetched by two words - the matrix arithmetic is unchanged,
// each sample being computed exactly once, and the second fetch is the neighbouring invocation's
// cache line.
//
// The matrix is the sensor's own, from the file (`camera_to_rec2020`), and not the fitted camera
// match - that one is the grade's and lives in `colour.slang`. Two different 3x3s, at two different
// ends of the pipeline.
import lanes;
import prelude;
import light;

struct Params {
    /// Row stride of the source plane, in pixels: the region RCD ran over, halo included.
    uint stride;
    /// Where this tile's own pixels start inside that region.
    uint left;
    uint top;
    /// This tile's size, in source pixels.
    uint width;
    uint height;
    /// Where the tile lands in the *unoriented* cropped frame.
    uint dest_left;
    uint dest_top;
    /// The whole unoriented cropped frame, which the orientation is defined against.
    uint frame_width;
    uint frame_height;
    /// `rawler`'s `Orientation`, as `orientation.rs` numbers it. 0 leaves the frame alone.
    uint orientation;
    /// The oriented frame's own size, and the destination's row stride in pixels.
    uint out_width;
    uint out_height;
    /// The first destination word this tile can reach, which is where its dispatch starts. A tile
    /// occupies a rectangle of the output, so the words between its first and last sample are
    /// contiguous even though its rows are not.
    uint first_word;
    /// Where `out` starts in the frame, in words.
    ///
    /// **The binding is the tile's own span, not the whole frame.** A 24MP frame is 144MB and
    /// WebGPU's default `maxStorageBufferBindingSize` is 128MiB, so binding it entire is one adapter
    /// away from a validation error - and a dropped dispatch reads as a very fast tick over a black
    /// canvas rather than as a failure. Every index below is absolute against the frame; the write
    /// subtracts this to land inside the binding.
    uint base_word;
    /// This tile's words as a rectangle of the destination: its first row, where it starts inside a
    /// row, and how many words of each row are its own.
    ///
    /// **Zero `tile_across` means the destination's rows are not whole words**, and the walk falls
    /// back to the span between the tile's first and last word. The host decides, in `word_grid`,
    /// because a row whose last word is shared with the next row's first cannot be split between
    /// two invocations of one dispatch - they would read-modify-write it against each other.
    uint tile_row;
    uint tile_word;
    uint tile_across;
    uint tile_rows;
    /// Photosites a side in the block one output pixel is read from, for `assemble_reduced`: 2 for a
    /// Bayer site, 3 for the smallest X-Trans window that holds every colour. Zero elsewhere, which
    /// that entry point reads as one.
    uint reduce;
    /// The rows below align to 16 and the nineteen words above end at 76, so the gap is written
    /// out rather than left implicit - the host builds these bytes by hand and can only write what
    /// it can see. `every_uniform_is_the_size_its_shader_reads` holds the two ends together.
    uint pad0;
    /// Camera RGB to Rec.2020, a row per vector. Three `float4` rather than a `float3x3` because the
    /// host writes these bytes by hand and a matrix's column stride is a rule to get wrong.
    ///
    /// Each row's `w` carries that channel's ceiling (`decode_rawler::channel_ceilings`), riding in
    /// the tail a `float3` would waste rather than in four more words of the block above.
    float4 row0;
    float4 row1;
    float4 row2;
};

// Group 0 is `mosaic.slang`'s, shared with both demosaics: the frame's extent, the CFA's period and
// the colour at every position of it. `samples` there is the conditioned mosaic this reads.
//
// **Which photosites ran out is a question only the mosaic can answer.** A demosaic reconstructs a
// green at a red site from its neighbours, and beside a blown stroke those neighbours are the blown
// ones - so the interpolated plane reports a channel at its ceiling a dozen pixels before that
// channel's own wells are full. Measured on IMG_0844: at the shoulder of an arc the green
// photosites are six tenths full and the interpolated green is already at the ceiling, which read
// as saturation turns fifteen pixels of a real gradient into flat white.
import mosaic;
import orientation;

[vk::binding(0, 1)] ConstantBuffer<Params> params;
[vk::binding(1, 1)] StructuredBuffer<float> rgb;
[vk::binding(2, 1)] RWStructuredBuffer<uint> out_frame;

/// Which source pixel a destination sample comes from, and which channel of it: `(x, y, channel)`,
/// with `w` zero where the sample is not this tile's to write.
///
/// The whole of the destination-side reasoning, shared by both entry points - only the fetch below
/// differs between reading RCD's plane and reading the mosaic direct.
uint4 source_for(uint sample)
{
    let pixel = sample / 3;
    let channel = sample % 3;
    let oy = pixel / params.out_width;
    let ox = pixel % params.out_width;
    if (oy >= params.out_height) { return uint4(0, 0, 0, 0); }

    // Back through the turn, then into the tile's own rectangle of the unoriented frame.
    let at = unoriented(
        uint2(ox, oy), uint2(params.frame_width, params.frame_height), params.orientation);
    if (at.x < params.dest_left || at.y < params.dest_top) { return uint4(0, 0, 0, 0); }
    let inside = uint2(at.x - params.dest_left, at.y - params.dest_top);
    if (inside.x >= params.width || inside.y >= params.height) { return uint4(0, 0, 0, 0); }

    return uint4(params.left + inside.x, params.top + inside.y, channel, 1);
}

/// How near its ceiling a channel counts as having saturated.
///
/// **Not equality, because RCD reconstructs a channel from its neighbours** - a green at a red site
/// is interpolated, so a blown plateau comes back a hair under the value every photosite in it
/// clipped to and an exact test leaves it unraised. Measured on a flat blown field, that miss is
/// enough to render the pixel in the illuminant's ratios, which is the whole failure.
///
/// Wide rather than tight on purpose: half a percent of the ceiling is within eighty counts of a
/// 14-bit sensor's saturation, and a photosite that close is blown for every purpose this serves.
static const float SATURATED_AT = 0.995;

/// Where a photosite is full enough that what it reads stops being taken at face value.
///
/// **Everything `reconstructed` does ramps over `BLOWN_FROM` to `SATURATED_AT` rather than
/// switching at either**, which is what keeps a blown highlight's edge graduated: a well fills
/// smoothly, so a correction that arrives all at once is an edge the sensor never recorded.
///
/// Wide, because the band is the width of the gradient it produces. On IMG_0275 the sun's red fill
/// falls from 1.0 to 0.55 over about a hundred and twenty pixels, so a band ending at 0.995 and
/// starting near it puts the whole neutral-to-warm transition inside a dozen of them.
static const float BLOWN_FROM = 0.75;

/// What a clipped photosite would have read, from the ones beside it that did not.
///
/// **The conditioning clips each photosite at its own saturation, so a channel on its ceiling is
/// one whose silicon ran out - "at least this bright", with no upper bound.** Left there it carries
/// the ceiling, and the ceilings are the white balance gains, so a pixel with every channel on one
/// leaves for the matrix in the *illuminant's* ratios and renders as a hue rather than as white.
/// That is a sun rendering pink.
///
/// **A colour a broadband illuminant made has no green-magenta component**, which after white
/// balance says green is the geometric mean of red and blue. Measured over IMG_0275's sun and its
/// surround, `g / sqrt(r.b)` runs 0.982 to 1.010 across the middle four fifths of the unclipped
/// sites. So where one channel clipped the other two say what it was, and the estimate is floored
/// at the ceiling because a clipped photosite has already proved that much.
///
/// **And held to the brightest channel the pixel actually read, which is what two channels can
/// prove between them.** Not to the clipped channel's own ceiling: the ceilings are the white
/// balance gains and green's is the lowest on every body here, so a neutral runs green out first
/// and every blown highlight needs green raised past that ceiling - held there, DSC04519's lit rock
/// leaves the decode at (0.605, 0.358, 0.68) and the picture is a magenta band a stop and a half
/// wide around each blown patch.
///
/// The top is where the rule's assumption fails rather than where the silicon did. DSC00982's
/// torch: red and green both on their ceilings, blue at 3.5% of its, and `g²/b` came to six times
/// the top and made the lamp deep red where the camera renders orange - blue's noise riding that
/// division into hue that flickered pixel by pixel. There red *is* the top, so the cap holds it
/// exactly where its own ceiling did.
///
/// **A narrow-band emitter is left alone by the floor rather than by the cap.** On IMG_0844's arcs
/// blue clips by itself, and `g²/r` off a red and green the light barely lit lands far under what
/// blue already read, so `max` keeps the measurement.
///
/// Two clipped leaves the equation a measurement short, and the channel still reading is all there
/// is to go on: at its own ceiling the pixel is about to have no colour at all, so the estimate
/// crosses to neutral as it approaches one. Three clipped has nothing left, and neutral is the
/// honest answer rather than the illuminant's own ratios.
/// How full each colour's photosites are about a place in the mosaic, as a fraction of its ceiling.
///
/// The 3x3, which holds at least one site of every colour whatever phase it is centred on, and
/// averaged rather than maximised: the question is how full the wells under this pixel are, and a
/// maximum would carry a blown neighbour outward exactly as the interpolation does.
float3 fills_at(uint x, uint y)
{
    let ceiling = float3(params.row0.w, params.row1.w, params.row2.w);
    // The plane's own extent, so a site past an edge is dropped rather than wrapped. Clamping the
    // coordinate instead would read one row along and pair that sample with this one's colour,
    // which is a relabelled photosite - the same failure an unaligned region origin causes. Which is
    // also why this indexes `samples` directly rather than taking `mosaic::sample`, whose clamp is
    // right for a filter and wrong here.
    let rows = shape.height;
    // Once, not nine times: `mosaic::Pattern` says what the difference measured.
    Pattern cfa;
    pattern(cfa);
    float3 sum = float3(0.0);
    float3 seen = float3(0.0);
    // Every site but the plane's own border has all nine of its neighbours, so the test each would
    // otherwise carry is one test for the nine, and the loop unrolls without a `continue` in it.
    // **What it no longer does is fold the parities away.** On a 2x2 pattern `dy` of -1 and +1 land
    // on the same row phase, so nine sites resolved to four reads of the pattern; a 6x6 period has
    // no such coincidence and every site is asked for its own colour.
    if (x >= 1u && y >= 1u && x + 1u < params.stride && y + 1u < rows) {
        [ForceUnroll]
        for (int dy = -1; dy <= 1; dy = dy + 1) {
            [ForceUnroll]
            for (int dx = -1; dx <= 1; dx = dx + 1) {
                let sy = int(y) + dy;
                let sx = int(x) + dx;
                let colour = colour_of(cfa, sy, sx);
                let value = samples[uint(sy) * params.stride + uint(sx)];
                if (colour == 0) { sum.r += value; seen.r += 1.0; }
                else if (colour == 2) { sum.b += value; seen.b += 1.0; }
                else { sum.g += value; seen.g += 1.0; }
            }
        }
        return (sum / max(seen, float3(1.0))) / max(ceiling, float3(1e-6));
    }
    for (int dy = -1; dy <= 1; dy = dy + 1) {
        let sy = int(y) + dy;
        if (sy < 0 || sy >= int(rows)) { continue; }
        for (int dx = -1; dx <= 1; dx = dx + 1) {
            let sx = int(x) + dx;
            if (sx < 0 || sx >= int(params.stride)) { continue; }
            let colour = colour_of(cfa, sy, sx);
            let value = samples[uint(sy) * params.stride + uint(sx)];
            if (colour == 0) { sum.r += value; seen.r += 1.0; }
            else if (colour == 2) { sum.b += value; seen.b += 1.0; }
            else { sum.g += value; seen.g += 1.0; }
        }
    }
    return (sum / max(seen, float3(1.0))) / max(ceiling, float3(1e-6));
}

/// `fill` is how full each colour's wells are under this pixel, as a fraction of its ceiling: the
/// one quantity comparable across channels whose ceilings differ and, unlike a count of how many
/// crossed, one that moves continuously. The caller's, because the two walks know it differently -
/// see `pixel_of_reduced`, which has it exactly and for free.
float3 reconstructed(float3 camera, float3 fill)
{
    let edge = 1e-6;
    let hi = max(fill.r, max(fill.g, fill.b));
    if (hi < BLOWN_FROM) { return camera; }
    let lo = min(fill.r, min(fill.g, fill.b));
    let mid = fill.r + fill.g + fill.b - hi - lo;

    // **Every strength below is a ramp on a fill and none is a branch on a count.** A photosite
    // does not stop reading at a threshold; it runs out. Switching a channel's estimate on the
    // count of clipped channels is what puts an edge in a picture - on IMG_0275 the second channel
    // leaves while the first is only four fifths of the way into its own ramp, and the two branches
    // disagree by a fifth of the correction across one pixel, which is a ring around the sun that
    // the sensor's own smooth fall never had.
    let top = max(camera.r, max(camera.g, camera.b));
    let zero_tint = min(float3(
        camera.g * camera.g / max(camera.b, edge),
        sqrt(max(camera.r * camera.b, 0.0)),
        camera.g * camera.g / max(camera.r, edge)), top);
    let held = lerp(camera, max(camera, zero_tint), smoothstep(BLOWN_FROM, SATURATED_AT, fill));

    // Two channels gone leaves the equation a measurement short and the third is all there is, so
    // the pull to neutral follows the *second* fill - which is exactly the one whose crossing used
    // to be the seam.
    //
    // The lowest fill gates it, and that is what keeps a saturated light out of it: a magenta whose
    // red and blue have both run out still has a green photosite a third full, and a green that
    // full flatly contradicts the neutral the pull would impose. Around the sun the same term is
    // the one channel still reading and it sits at 0.97, so the pull arrives in full.
    let blown = smoothstep(BLOWN_FROM, SATURATED_AT, mid) * smoothstep(BLOWN_FROM, SATURATED_AT, lo);
    return lerp(held, float3(top), blown);
}

/// That source colour through the camera matrix, as a fraction of full scale.
///
/// **All three rows and no channel picked yet, because a camera matrix takes real scene colours
/// outside Rec.2020 and only the whole triple can be brought back.** A narrow-band emitter is
/// outside the primaries on its own, and clipping the negative channel where it stands is a hue
/// shift rather than a clip - `prelude::in_gamut` carries the measurement. `within` is the same rule
/// at the far end: a component past the container comes down by scaling the colour, not by
/// flattening the one that crossed.
float3 rec2020_of(float3 camera)
{
    // A fraction of full scale, which is the ceiling below and what `channel_of`'s `* 65535`
    // turns back into a count.
    let rec2020 = measured<Assembled>(float3(
        dot(params.row0.xyz, camera),
        dot(params.row1.xyz, camera),
        dot(params.row2.xyz, camera)));
    return within(in_gamut(rec2020), exactly<Assembled>(1.0)).v;
}

/// One of those three as a `u16` count.
///
/// Truncated, not rounded, because the host pass this replaces truncated: `as u16` on a clamped
/// `f32`. A round here would move a fifth of every fixture by a count for no reason anyone asked for.
uint channel_of(float3 held, uint channel)
{
    float value = held.r;
    if (channel == 1) { value = held.g; }
    if (channel == 2) { value = held.b; }
    return uint(clamp(value * 65535.0, 0.0, 65535.0));
}

/// One pixel of the destination, in Rec.2020, off the plane RCD reconstructed.
///
/// A *pixel* and not a sample, because the two samples of a destination word are the same pixel's
/// two out of three times: three samples to a pixel and two to a word, so only the word that
/// straddles a pixel boundary has two of these to do. Everything here is per pixel - a nine-tap
/// fill, a clipping correction and a 3x3 through a gamut map - and taking it per sample did all of
/// it twice for a channel each. Measured on RADV over the three bench fixtures in sequence, which
/// is what the budget records, the 61MP frame's reduced walk went from 118ms to 71 against 105.7.
float3 pixel_of(uint2 site)
{
    let base = (site.y * params.stride + site.x) * 3;
    // Off the mosaic rather than off the interpolation, which is the whole point of the correction:
    // beside a blown stroke the neighbours RCD reconstructs from are the blown ones, so the plane
    // reports a channel at its ceiling well before that channel's own wells are full.
    let camera = reconstructed(
        float3(rgb[base], rgb[base + 1], rgb[base + 2]), fills_at(site.x, site.y));
    return rec2020_of(camera);
}

/// The same, off the mosaic, one output pixel per block of `params.reduce` photosites a side.
///
/// **The demosaic skipped rather than approximated.** A block that already holds every colour has
/// nothing to interpolate, so a caller who asked for a frame no larger than that fraction of the
/// sensor gets the photosites read directly. `params.stride` is the mosaic's own width here, and the
/// tile's coordinates are in the reduced grid.
///
/// **The factor is the pattern's, not the caller's.** A Bayer 2x2 is the smallest block holding one
/// of each colour; X-Trans has none, and its smallest is the 3x3 - twenty greens to eight reds over
/// the 6x6 means every 3x3 window carries all three (`every_three_by_three_window_holds_every_colour`).
/// So the same traversal serves both at two and at three, and what changes is how many samples each
/// colour gets.
///
/// Every sample of a colour averaged, rather than the last one kept: Bayer's two greens are the same
/// colour sampled twice and taking one would throw away half the luminance the sensor spends half its
/// photosites collecting. On X-Trans a 3x3 holds five of them, and the argument is the same one.
/// **`SIDE` is a generic and not a uniform, and the bench is why.** As a runtime loop bound this
/// stopped unrolling, and the route it serves is the one a 61MP grid tile takes: measured, the
/// demosaic stage went from 105ms to 227ms against a budget of 105.7. One body, two instantiations,
/// both flat.
float3 pixel_of_reduced<let SIDE : int>(uint2 at)
{
    let side = SIDE;
    Pattern cfa;
    pattern(cfa);
    float3 sums = float3(0.0);
    float3 counts = float3(0.0);
    // **Off one base index, a row at a time.** Spelled as `sy * stride + sx` per site the block's
    // reads are four independent addresses the compiler has to prove adjacent before it can fetch
    // them together; the walk this replaced took `top`, `top + 1`, `top + stride` and read two
    // dwords at a time. On an adapter whose memory is the system's that is the difference between
    // two fetches a pixel and four.
    let top = (uint(at.y) * uint(side)) * params.stride + uint(at.x) * uint(side);
    [ForceUnroll]
    for (int dy = 0; dy < side; dy = dy + 1) {
        let row = top + uint(dy) * params.stride;
        let sy = int(at.y) * side + dy;
        [ForceUnroll]
        for (int dx = 0; dx < side; dx = dx + 1) {
            let value = rgb[row + uint(dx)];
            // Three scalar accumulations rather than a masked vector one: the mask spends three
            // compares, three conversions and six fused multiplies where this spends one compare
            // and two adds, and only one of the three is ever live.
            let colour = colour_of(cfa, sy, int(at.x) * side + dx);
            if (colour == 0) { sums.r += value; counts.r += 1.0; }
            else if (colour == 2) { sums.b += value; counts.b += 1.0; }
            else { sums.g += value; counts.g += 1.0; }
        }
    }
    var camera = sums / max(counts, float3(1.0));
    // **The block's own means are the fill, so this route never calls `fills_at`.** That function
    // exists because an interpolated plane cannot say how full the wells under it were; these are
    // the wells, read directly, and dividing by the ceiling is the whole of the conversion. It is
    // the better answer as well as the free one - a 3x3 centred on the block would carry sites the
    // output pixel is not made of - and it is most of what the route costs: measured on the 61MP
    // fixture alone on RADV, the nine reads and nine colour lookups it replaces were 57ms of 168.
    let ceiling = float3(params.row0.w, params.row1.w, params.row2.w);
    return rec2020_of(reconstructed(camera, camera / max(ceiling, float3(1e-6))));
}

/// The side of the square of destination words one workgroup owns.
///
/// **The workgroup is a patch of the destination rather than a run of it, and under a quarter turn
/// that is what decides the read.** A destination row is a source *column*, so 64 words in a row
/// are 42 source rows touched for four bytes apiece - a cache line each. Eight rows by eight words
/// reads eight adjacent source columns instead, which is 32 bytes of every line fetched.
static const uint PATCH = 8;

/// Which destination word this invocation owns, or `~0u` where it owns none.
///
/// A patch of the tile's own rectangle where the host worked out that its rows are whole words, and
/// the tile's whole span where it could not - see `tile_across`.
uint owned_word(uint3 group, uint3 local, uint3 id)
{
    if (params.tile_across == 0) {
        return linear(id) + params.first_word;
    }
    let across = group.x * PATCH + local.x % PATCH;
    let down = group.y * PATCH + local.x / PATCH;
    if (across >= params.tile_across || down >= params.tile_rows) { return ~0u; }
    let row_words = params.out_width * 3 / 2;
    return (params.tile_row + down) * row_words + params.tile_word + across;
}

/// One destination word, keeping whatever half is not this tile's.
///
/// That half belongs to the tile beside it, which an earlier pass has already written - which is
/// why each tile is its own submit rather than all of them one dispatch.
void put(uint word, uint2 low, uint2 high)
{
    if (low.y == 0 && high.y == 0) { return; }
    uint held = out_frame[word];
    if (low.y == 1) { held = (held & 0xffff0000) | low.x; }
    if (high.y == 1) { held = (held & 0x0000ffff) | (high.x << 16); }
    out_frame[word] = held;
}

/// One word of the destination frame.
///
/// Dispatched over the words this tile can reach, which is the span between its first and last
/// destination sample - a rectangle in the output, so the span is contiguous even when the tile's
/// own rows are not.
[shader("compute")]
[numthreads(64, 1, 1)]
void assemble_rec2020(uint3 id : SV_DispatchThreadID, uint3 group : SV_GroupID, uint3 local : SV_GroupThreadID)
{
    let word = owned_word(group, local, id);
    let samples = params.out_width * params.out_height * 3;
    if (word == ~0u || word * 2 >= samples) { return; }

    let a = source_for(word * 2);
    var b = uint4(0, 0, 0, 0);
    if (word * 2 + 1 < samples) { b = source_for(word * 2 + 1); }

    var low = uint2(0, 0);
    var high = uint2(0, 0);
    if (a.w != 0) {
        let held = pixel_of(a.xy);
        low = uint2(channel_of(held, a.z), 1);
        // The same pixel two times in three, and then its whole reconstruction is already here.
        if (b.w != 0 && b.x == a.x && b.y == a.y) { high = uint2(channel_of(held, b.z), 1); }
    }
    if (high.y == 0 && b.w != 0) { high = uint2(channel_of(pixel_of(b.xy), b.z), 1); }
    put(word - params.base_word, low, high);
}

/// The same word, off the mosaic, for a frame that skips the demosaic.
///
/// A copy of the loop above differing in its fetch, for `reduce.slang`'s reason: the arithmetic that
/// can be wrong - `source_for`, `channel_of` and `put` - is shared, and the two walks sit adjacent
/// to be edited in pairs.
///
/// One walk for both factors, instantiated twice: what differs between a Bayer sensor's half and an
/// X-Trans sensor's third is the block's side and nothing else, so the body is written once and the
/// two entry points below name the number. A uniform would have spelled the same thing and cost the
/// unroll, which is most of what this route is.
void assemble_block<let SIDE : int>(uint3 id, uint3 group, uint3 local)
{
    let word = owned_word(group, local, id);
    let samples = params.out_width * params.out_height * 3;
    if (word == ~0u || word * 2 >= samples) { return; }

    let a = source_for(word * 2);
    var b = uint4(0, 0, 0, 0);
    if (word * 2 + 1 < samples) { b = source_for(word * 2 + 1); }

    var low = uint2(0, 0);
    var high = uint2(0, 0);
    if (a.w != 0) {
        let held = pixel_of_reduced<SIDE>(a.xy);
        low = uint2(channel_of(held, a.z), 1);
        if (b.w != 0 && b.x == a.x && b.y == a.y) { high = uint2(channel_of(held, b.z), 1); }
    }
    if (high.y == 0 && b.w != 0) {
        high = uint2(channel_of(pixel_of_reduced<SIDE>(b.xy), b.z), 1);
    }
    put(word - params.base_word, low, high);
}

/// A Bayer 2x2 site to a pixel.
[shader("compute")]
[numthreads(64, 1, 1)]
void assemble_halved(uint3 id : SV_DispatchThreadID, uint3 group : SV_GroupID, uint3 local : SV_GroupThreadID)
{
    assemble_block<2>(id, group, local);
}

/// The smallest X-Trans window that holds every colour, likewise.
[shader("compute")]
[numthreads(64, 1, 1)]
void assemble_thirded(uint3 id : SV_DispatchThreadID, uint3 group : SV_GroupID, uint3 local : SV_GroupThreadID)
{
    assemble_block<3>(id, group, local);
}
