// The demosaiced frame into the camera's colour, cropped, turned upright, and written straight into
// the frame every stage after the decode reads.
//
// RCD leaves interleaved `f32` RGB in the sensor's own primaries; what a frame is measured and graded
// in is Rec.2020 half-float levels (`packed::level_of`), upright, cropped to the readable area.
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
import px;
import times;

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
    /// Where the mosaic this dispatch reads starts in the one `highlight` was measured over, and
    /// that field's cells: how many, and photosites a side in each.
    uint field_left;
    uint field_top;
    uint field_width;
    uint field_height;
    uint field_cell;
    /// How much of the surrounding light's colour a reconstruction keeps, against neutral white:
    /// where a channel still reads, and where every channel ran out (`highlight::Colouring`).
    float colour_reading;
    float colour_blown;
    uint pad0;
    uint pad1;
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
import clipping;
import mosaic;
import orientation;
import packed;

[vk::binding(0, 1)] ConstantBuffer<Params> params;
[vk::binding(1, 1)] StructuredBuffer<float> rgb;
[vk::binding(2, 1)] RWStructuredBuffer<uint> out_frame;
/// The colour of the light around each clipped highlight, as `highlight_field.slang` filled it.
[vk::binding(3, 1)] StructuredBuffer<float4> highlight;

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
    // Every site asks the pattern for its own colour: `dy` of -1 and +1 share a row phase only on a
    // 2x2 period, never on a 6x6 one.
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

/// The colour share of the light around a place in this dispatch's mosaic
/// (`highlight_field.slang`'s `estimates`), bilinear between the field's cell centres.
float3 light_around(float2 at)
{
    let cells = (at + float2(params.field_left, params.field_top)) / float(params.field_cell) - 0.5;
    let base = int2(floor(cells));
    let t = cells - float2(base);
    var share = float4(0.0);
    [ForceUnroll]
    for (int dy = 0; dy < 2; dy++) {
        [ForceUnroll]
        for (int dx = 0; dx < 2; dx++) {
            let x = clamp(base.x + dx, 0, int(params.field_width) - 1);
            let y = clamp(base.y + dy, 0, int(params.field_height) - 1);
            let w = (dx == 0 ? 1.0 - t.x : t.x) * (dy == 0 ? 1.0 - t.y : t.y);
            share += w * highlight[uint(y) * params.field_width + uint(x)];
        }
    }
    return share.rgb;
}

/// How far under the light that clips every channel a pixel's handover from `colour_reading` to
/// `colour_blown` begins, measured on the least-full channel: a channel's own last quarter is
/// crossed in one pixel on a steep edge.
static const Stops WHITENS_OVER = { 1.5 };

/// What a clipped photosite would have read. `fill` is each colour's wells under this pixel as a
/// fraction of its ceiling.
///
/// Every strength ramps on a fill: a branch on a count of clipped channels draws a ring.
float3 reconstructed(float3 camera, float3 fill, float2 at)
{
    let hi = max(fill.r, max(fill.g, fill.b));
    if (hi < BLOWN_FROM) { return camera; }
    let around = light_around(at);
    let gone = running_out(fill);
    // Off the photosites once a channel runs out: RCD interpolates a run-out channel from green and
    // green from it, a scale pattern the wells never had.
    let ceiling = float3(params.row0.w, params.row1.w, params.row2.w);
    let wells = lerp(camera, fill * ceiling, smoothstep(0.0, 0.5, max(gone.r, max(gone.g, gone.b))));
    let reading = 1.0 - gone;
    let measured = smoothstep(0.0, 0.5, reading.r + reading.g + reading.b);
    let lo = min(fill.r, min(fill.g, fill.b));
    let toward_clip = smoothstep(-WHITENS_OVER.s, 0.0, log2(max(lo, 1e-6)));
    let kept = lerp(params.colour_reading, params.colour_blown * vivid(around), toward_clip);
    let neutral = broadband(wells, fill);
    let lit = lit_like(wells, gone, measured, around) * luma_of(neutral);
    return lerp(neutral, fitted(neutral, lit), kept);
}

static const float VIVID_FROM = 0.6;
static const float VIVID_TO = 1.4;

float vivid(float3 share)
{
    let unit = to_rec2020(share) / max(luma_of(share), 1e-6);
    // Distance from white at unit luma: a lamp's orange is near, a pink light far.
    return smoothstep(VIVID_FROM, VIVID_TO, length(unit - 1.0));
}

/// Of sensor full scale.
static const Gain HEADROOM = { 8.0 };

/// `lit` pulled toward `neutral` at the same luma until no channel passes `HEADROOM`. Luma, not the
/// brightest channel: held there, an orange blown face reads darker than the rock beside it.
float3 fitted(float3 neutral, float3 lit)
{
    let from = to_rec2020(neutral);
    let toward = to_rec2020(lit) - from;
    let room = (float3(HEADROOM.g) - from) / max(toward, float3(1e-6));
    let t = clamp(min(toward.r > 0.0 ? room.r : 1.0, min(toward.g > 0.0 ? room.g : 1.0, toward.b > 0.0 ? room.b : 1.0)), 0.0, 1.0);
    return lerp(neutral, lit, t);
}

float3 to_rec2020(float3 camera)
{
    return float3(dot(params.row0.xyz, camera), dot(params.row1.xyz, camera), dot(params.row2.xyz, camera));
}

/// The light around's hue, fitted to the channels still reading, at unit luma. A clipped channel
/// only proved "at least this bright", so it is raised to the light's colour and never lowered.
float3 lit_like(float3 camera, float3 gone, float measured, float3 around)
{
    let edge = 1e-6;
    let reading = 1.0 - gone;
    let share = max(around, float3(edge));
    // A filling channel reads low before it reads clipped - some photosites in its 3x3 have run out
    // - so the scale leans on channels well under their ceilings; proportional, a nine-tenths green
    // sits under red and blue on a blown neutral as magenta.
    let trusted = reading * reading;
    let read_scale = dot(trusted * camera, share) / max(dot(trusted * share, share), edge);
    let read_lit = lerp(camera, max(camera, read_scale * share), smoothstep(0.0, 0.5, gone));
    let unit = lerp(share / max(luma_of(share), edge), read_lit / max(luma_of(read_lit), edge), measured);
    return unit / max(luma_of(unit), edge);
}

float luma_of(float3 camera)
{
    return dot(LUMA, to_rec2020(camera));
}

/// The pixel alone, assuming broadband light: after white balance green is the geometric mean of
/// red and blue, so two channels say what a clipped third was.
///
/// Capped at the brightest channel read, or a noisy low blue turns `g²/b` into a deep red torch.
/// Raised to the brightest still reading, not left at the clipped ceiling: green's is lowest, so a
/// blown neutral rings magenta. All three gone is neutral; the illuminant's ratios render a sun pink.
float3 broadband(float3 camera, float3 fill)
{
    let edge = 1e-6;
    let hi = max(fill.r, max(fill.g, fill.b));
    let lo = min(fill.r, min(fill.g, fill.b));
    let mid = fill.r + fill.g + fill.b - hi - lo;
    let top = max(camera.r, max(camera.g, camera.b));
    let zero_tint = min(float3(
        camera.g * camera.g / max(camera.b, edge),
        sqrt(max(camera.r * camera.b, 0.0)),
        camera.g * camera.g / max(camera.r, edge)), top);
    let gone = running_out(fill);
    let estimated = lerp(camera, max(camera, zero_tint), gone);
    // Two clipped channels tie the zero-tint estimates to their ceilings. Normalize the remaining
    // channel weights so a partly clipped blue cannot leave a blue ring around a neutral light.
    let left = 1.0 - gone;
    let still = dot(camera, left) / max(left.r + left.g + left.b, edge);
    let held = lerp(estimated, max(estimated, float3(still)), gone * running_out(float3(mid)).x);
    // The pull to neutral follows the *second* fill, and the lowest gates it: a magenta whose red
    // and blue have both run out still has a green photosite a third full, which flatly contradicts
    // the neutral the pull would impose.
    let blown = running_out(float3(mid)).x * running_out(float3(lo)).x;
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
    // A fraction of full scale, which `channel_of` stores as a level.
    let rec2020 = measured<Assembled>(float3(
        dot(params.row0.xyz, camera),
        dot(params.row1.xyz, camera),
        dot(params.row2.xyz, camera)));
    return within(in_gamut(rec2020), exactly<Assembled>(HEADROOM.g)).v;
}

/// One of those three as a scene-linear sample (`packed::bits_of`).
uint channel_of(float3 held, uint channel)
{
    float value = held.r;
    if (channel == 1) { value = held.g; }
    if (channel == 2) { value = held.b; }
    return bits_of(max(value, 0.0) * FULL_SCALE);
}

/// One pixel of the destination, in Rec.2020, off the plane RCD reconstructed.
///
/// A *pixel* and not a sample, because the two samples of a destination word are the same pixel's
/// two out of three times: three samples to a pixel and two to a word, so only the word that
/// straddles a pixel boundary has two of these to do. Everything here is per pixel - a nine-tap
/// fill, a clipping correction and a 3x3 through a gamut map - and taking it per sample would do all
/// of it twice for a channel each.
float3 pixel_of(uint2 site)
{
    let base = wide_at<Sensor>(site.x, site.y, measured<Sensor>(params.stride)) * 3;
    // Off the mosaic rather than off the interpolation, which is the whole point of the correction:
    // beside a blown stroke the neighbours RCD reconstructs from are the blown ones, so the plane
    // reports a channel at its ceiling well before that channel's own wells are full.
    let camera = reconstructed(
        float3(rgb[base], rgb[base + 1], rgb[base + 2]),
        fills_at(site.x, site.y),
        float2(site) + 0.5);
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
/// **`SIDE` is a generic and not a uniform, and the bench is why.** As a runtime loop bound it does
/// not unroll, and this is the route a 61MP grid tile takes. One body, two instantiations, both flat.
float3 pixel_of_reduced<let SIDE : int>(uint2 at)
{
    let side = SIDE;
    Pattern cfa;
    pattern(cfa);
    float3 sums = float3(0.0);
    float3 counts = float3(0.0);
    // **Off one base index, a row at a time.** Spelled as `sy * stride + sx` per site the block's
    // reads are four independent addresses the compiler has to prove adjacent before it can fetch
    // them together. On an adapter whose memory is the system's that is two fetches a pixel against
    // four.
    let top = times(uint(at.y), uint(side)) * params.stride + times(uint(at.x), uint(side));
    [ForceUnroll]
    for (int dy = 0; dy < side; dy = dy + 1) {
        let row = top + uint(dy) * params.stride;
        let sy = times(int(at.y), side) + dy;
        [ForceUnroll]
        for (int dx = 0; dx < side; dx = dx + 1) {
            let value = rgb[row + uint(dx)];
            // Three scalar accumulations rather than a masked vector one: the mask spends three
            // compares, three conversions and six fused multiplies where this spends one compare
            // and two adds, and only one of the three is ever live.
            let colour = colour_of(cfa, sy, times(int(at.x), side) + dx);
            if (colour == 0) { sums.r += value; counts.r += 1.0; }
            else if (colour == 2) { sums.b += value; counts.b += 1.0; }
            else { sums.g += value; counts.g += 1.0; }
        }
    }
    var camera = sums / max(counts, float3(1.0));
    // **The block's own means are the fill, so this route never calls `fills_at`.** That function
    // exists because an interpolated plane cannot say how full the wells under it were; these are
    // the wells, read directly, and dividing by the ceiling is the whole of the conversion. It is
    // the better answer as well as the free one: a 3x3 centred on the block would carry sites the
    // output pixel is not made of.
    let ceiling = float3(params.row0.w, params.row1.w, params.row2.w);
    let centre = (float2(at) + 0.5) * float(side);
    return rec2020_of(reconstructed(camera, camera / max(ceiling, float3(1e-6)), centre));
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
    let row_words = times(params.out_width, 3) / 2;
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
    let samples = wide<Drawn>(params.out_width * params.out_height) * 3;
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
    let samples = wide<Drawn>(params.out_width * params.out_height) * 3;
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
