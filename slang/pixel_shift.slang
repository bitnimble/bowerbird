// A sensor-shift burst merged on the photosite lattice, in place of a demosaic.
//
// Each frame of a 4-shot burst sits a photosite from the last, round a 2x2 block, so over the four
// every output site has been read once through red, twice through green and once through blue. One
// dispatch per frame, each adding its photosites into the channel their filter names; what comes out
// is the interleaved plane RCD writes, for `assemble.slang` to colour and crop.

struct Params {
    uint width;
    uint height;
    /// Where this frame's photosites landed against the reference's, in rows and columns.
    int dy;
    int dx;
    /// The colour at each position of the 2x2 period, row-major: 0 red, 1 green, 2 blue.
    uint4 colours;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> samples;
[vk::binding(2, 0)] RWStructuredBuffer<float> rgb;

/// Stepped a whole period back inside at the edge, which keeps the photosite's colour.
int inside(int at, int extent)
{
    if (at < 0) { return at + 2; }
    if (at >= extent) { return at - 2; }
    return at;
}

[shader("compute")]
[numthreads(8, 8, 1)]
void scatter(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.width || gid.y >= params.height) { return; }
    let r = inside(int(gid.y) - params.dy, int(params.height));
    let c = inside(int(gid.x) - params.dx, int(params.width));
    let colour = params.colours[(r % 2) * 2 + c % 2];
    let value = samples[uint(r) * params.width + uint(c)];
    let at = (gid.y * params.width + gid.x) * 3 + colour;
    rgb[at] += select(colour == 1, 0.5 * value, value);
}
