// The fit's planes, built where the search and the pairs read them: a plane warped through the
// lens, a plane reduced to luma, or a plane box-averaged down to a grid, one pass each over f32 RGB
// - or, for the box, over an 8-bit source's own bytes through a level table.
//
// **Bilinear, not the Catmull-Rom of `warp.slang`.** That kernel is the *output* path, where
// bilinear's softening is radial and visible - the warp holds the frame centre fixed, so the centre
// is untouched while the edge moves ~23px. The fit correlates normalised 7x7 patches and takes an
// argmax over +-4px, which a smooth radial softening barely moves, and the geometry search scores
// planes blurred past anything a sharper filter would keep.
//
// The radial ratio table is the host's (`image::channel_ratio_table`) - 4097 entries, so it is
// nothing to compute or to upload, and it is the only thing that changes between the settle's
// rounds. One table per channel: they are identical unless the lens carries a lateral correction,
// which makes the per-channel path free rather than a second one.
import prelude;
import footprint;

struct Params {
    int source_width;
    int source_height;
    int width;
    int height;
    /// Zero where the lens moves nothing. Reading the pixel rather than gathering it is not an
    /// optimisation: the ratio table's identity is `(x - w/2) / half * half`, which lands a hair
    /// off `x` and taps four neighbours for a pixel that should come back untouched.
    int warping;
    float half;
    /// Source pixels per output pixel, which the ratio multiplies into.
    float step_x;
    float step_y;
    /// One float a pixel, the luma, rather than three.
    int luma;
    /// What the plane is finished with on the way out: `FINISH_NONE`, `FINISH_MATRIX` through
    /// `finish`, or `FINISH_CODES`, which rounds onto 0..255.
    int finish_with;
    /// What every sample is multiplied by on the way out: the fit's normalisation by diffuse
    /// white, done here rather than as a host pass over the plane between the two device passes
    /// either side of it. One where nothing is being normalised.
    float scale;
    /// To the 16-byte boundary the array below starts on.
    int pad0;
    /// A row to a `float4`, which is what std140 gives a `float3x3` anyway.
    float4 finish[3];
};
[vk::binding(20, 0)] ConstantBuffer<Params> pc;

/// Interleaved f32 RGB, `source_width` by `source_height`.
[vk::binding(0, 0)] StructuredBuffer<float> source;
/// Whatever this dispatch reads by radius: the warp's three ratio tables of `TABLE_LAST + 1`
/// entries, one per channel, or `FINISH_FALLOFF`'s 256 gains.
[vk::binding(1, 0)] StructuredBuffer<float> radial;
/// `width` by `height`: interleaved RGB, or one luma a pixel where `pc.luma` says so.
[vk::binding(2, 0)] RWStructuredBuffer<float> plane;
/// What `fit_box_packed` averages for each 8-bit code: 256 entries.
[vk::binding(3, 0)] StructuredBuffer<float> levels;
/// Interleaved 8-bit RGB, four samples to a word, `source_width` by `source_height`.
[vk::binding(4, 0)] StructuredBuffer<uint> source_bytes;

static const int TABLE_LAST = 4096;

static const int FINISH_NONE = 0;
/// Through `pc.finish`, for a plane whose primaries are not the ones the fit works in.
static const int FINISH_MATRIX = 1;
/// Onto the 255 steps an 8-bit source's codes live on, and back into 0..1. The average of a box of
/// codes is not one, and the caller wants the code the camera would have written - carried at the
/// width every other plane here is, so that a grid the geometry search reads never has to come back
/// to the host to be rounded and sent up again. `fit_source.slang`'s `fit_render` does the same.
static const int FINISH_CODES = 2;
/// The lens's own falloff lifted back in, `radial` holding `fit::Gain::at` per radius bucket. Read
/// by `fit_box` alone rather than in `write`, so that `fit_box_packed` - which never carries one -
/// does not have to bind a radial table to say so.
static const int FINISH_FALLOFF = 3;

float falloff_at(int pixel)
{
    if (pc.finish_with != FINISH_FALLOFF) { return 1.0; }
    let dx = float(pixel % pc.width) - float(pc.width) * 0.5;
    let dy = float(pixel / pc.width) - float(pc.height) * 0.5;
    return radial[int(min(sqrt(dx * dx + dy * dy) / pc.half * 255.0, 255.0))];
}

void write(int pixel, float3 rgb)
{
    // Every finish happens here rather than in a host loop reading this plane back to walk it:
    // they are a matrix, a round and a multiply over every pixel, which is the shape of
    // everything else in this file.
    let scaled = rgb * pc.scale;
    var out = scaled;
    if (pc.finish_with == FINISH_MATRIX) {
        out = float3(
            dot(pc.finish[0].xyz, scaled),
            dot(pc.finish[1].xyz, scaled),
            dot(pc.finish[2].xyz, scaled));
    } else if (pc.finish_with == FINISH_CODES) {
        out = clamp(round(scaled), float3(0.0), float3(255.0)) / 255.0;
    }

    if (pc.luma != 0) {
        plane[pixel] = dot(LUMA, out);
        return;
    }
    plane[pixel * 3] = out.x;
    plane[pixel * 3 + 1] = out.y;
    plane[pixel * 3 + 2] = out.z;
}

/// The source through the lens at its own size, or as it is where `pc.warping` is zero.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_warp(uint3 id: SV_DispatchThreadID)
{
    let x = int(id.x);
    let y = int(id.y);
    if (x >= pc.width || y >= pc.height) { return; }

    let sw = pc.source_width;
    let sh = pc.source_height;
    let pixel = y * pc.width + x;

    if (pc.warping == 0) {
        let i = (y * sw + x) * 3;
        write(pixel, float3(source[i], source[i + 1], source[i + 2]));
        return;
    }
    if (sw < 2 || sh < 2) {
        write(pixel, float3(0.0));
        return;
    }

    let dx = (float(x) - float(pc.width) * 0.5) / pc.half;
    let dy = (float(y) - float(pc.height) * 0.5) / pc.half;
    let t = (dx * dx + dy * dy) * float(TABLE_LAST);
    let slot = t < float(TABLE_LAST) ? int(t) : TABLE_LAST - 1;

    let centre_x = float(sw) * 0.5;
    let centre_y = float(sh) * 0.5;
    let edge_x = float(sw - 1);
    let edge_y = float(sh - 1);

    // Zero where a channel reads outside the source: the pair gate downstream treats a black
    // sample as the warp's own margin rather than as content.
    var rgb = float3(0.0);
    for (int c = 0; c < 3; c++) {
        let table = c * (TABLE_LAST + 1);
        let low = radial[table + slot];
        let ratio = low + (radial[table + slot + 1] - low) * (t - float(slot));
        let px = centre_x + dx * ratio * pc.step_x;
        let py = centre_y + dy * ratio * pc.step_y;
        if (px < 0.0 || py < 0.0 || px > edge_x || py > edge_y) { continue; }

        let x0 = min(int(px), sw - 2);
        let y0 = min(int(py), sh - 2);
        let fx = px - float(x0);
        let fy = py - float(y0);
        let i00 = (y0 * sw + x0) * 3 + c;
        let i01 = i00 + sw * 3;
        rgb[c] = source[i00] * (1.0 - fx) * (1.0 - fy)
            + source[i00 + 3] * fx * (1.0 - fy)
            + source[i01] * (1.0 - fx) * fy
            + source[i01 + 3] * fx * fy;
    }

    write(pixel, rgb);
}

int4 box_at(int dx, int dy)
{
    return box_of(int2(dx, dy), int2(pc.source_width, pc.source_height), int2(pc.width, pc.height));
}

/// The box average `fit_source.slang`'s `fit_resize` takes of a frame, over a plane already held as
/// floats: deliberately not a filtered resize, so neither side of a pair is sharpened relative to
/// the other.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_box(uint3 id: SV_DispatchThreadID)
{
    let dx = int(id.x);
    let dy = int(id.y);
    if (dx >= pc.width || dy >= pc.height) { return; }

    let b = box_at(dx, dy);
    var acc = float3(0.0);
    for (int y = b.z; y < b.w; y++) {
        for (int x = b.x; x < b.y; x++) {
            let i = (y * pc.source_width + x) * 3;
            acc += float3(source[i], source[i + 1], source[i + 2]);
        }
    }
    let pixel = dy * pc.width + dx;
    write(pixel, falloff_at(pixel) * acc / float((b.w - b.z) * (b.y - b.x)));
}

float level(int at)
{
    return levels[(source_bytes[at >> 2] >> uint(8 * (at & 3))) & 0xff];
}

/// `fit_box` over `source_bytes` through `levels`, so an 8-bit source is uploaded once as its own
/// bytes and averaged in whichever domain the table maps it into.
[shader("compute")]
[numthreads(16, 16, 1)]
void fit_box_packed(uint3 id: SV_DispatchThreadID)
{
    let dx = int(id.x);
    let dy = int(id.y);
    if (dx >= pc.width || dy >= pc.height) { return; }

    let b = box_at(dx, dy);
    var acc = float3(0.0);
    for (int y = b.z; y < b.w; y++) {
        for (int x = b.x; x < b.y; x++) {
            let i = (y * pc.source_width + x) * 3;
            acc += float3(level(i), level(i + 1), level(i + 2));
        }
    }
    write(dy * pc.width + dx, acc / float((b.w - b.z) * (b.y - b.x)));
}
