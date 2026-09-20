// Phase 4: the colour the luma plane had taken out of it, one value per 2x2 site.
//
// Half resolution because a Bayer site has one of each colour, so this is the natural rate for
// colour and nothing is thrown away by working at it. A 6x6 pattern is read on the same grid and
// is oversampled there, which costs a little bandwidth and keeps every kernel above this one -
// the pyramid, the LOESS, the guided upsample, the inverse - working at the size it already did.
//
// **Two different transforms, because a 2x2 window of X-Trans does not span the colours.** One
// site in nine of that pattern is four greens: no combination of the four samples under it carries
// a red-minus-blue, so the Walsh-Hadamard triple the Bayer path extracts is not merely awkward
// there, it is empty. What is measured instead is the pattern's own period - which holds the same
// count of every colour wherever it starts, on any CFA - and the two chroma axes come off those
// three means.
import prelude;

[vk::binding(0, 0)] StructuredBuffer<float> in_gat_full;
[vk::binding(1, 0)] RWStructuredBuffer<float> c1_h;
[vk::binding(2, 0)] RWStructuredBuffer<float> c2_h;
[vk::binding(3, 0)] RWStructuredBuffer<float> c3_h;

struct Push {
    int width;
    int height;
    int halfwidth;
    int halfheight;
    int period_w;
    int period_h;
    uint packed0;
    uint packed1;
    uint packed2;
    float gain_c1;
    float gain_c2;
};
[vk::binding(20, 0)] ConstantBuffer<Push> pc;

[shader("compute")]
[numthreads(16, 16, 1)]
void chroma_extract_halfres(uint3 id : SV_DispatchThreadID)
{
    let hx = int(id.x);
    let hy = int(id.y);
    if (hx >= pc.halfwidth || hy >= pc.halfheight) { return; }

    let fr = 2 * hy;
    let fc = 2 * hx;
    let hp = hy * pc.halfwidth + hx;

    if (fr + 1 >= pc.height || fc + 1 >= pc.width) {
        c1_h[hp] = 0.0;
        c2_h[hp] = 0.0;
        c3_h[hp] = 0.0;
        return;
    }

    if (pc.period_w == 2 && pc.period_h == 2) {
        let r = in_gat_full[fr * pc.width + fc];
        let gb = in_gat_full[(fr + 1) * pc.width + fc];
        let gr = in_gat_full[fr * pc.width + (fc + 1)];
        let b = in_gat_full[(fr + 1) * pc.width + (fc + 1)];

        c1_h[hp] = 0.5 * (r - gb + gr - b);
        c2_h[hp] = 0.5 * (r + gb - gr - b);
        c3_h[hp] = 0.5 * (r - gb - gr + b);
        return;
    }

    Pattern pat = { pc.period_w, pc.period_h, pc.packed0, pc.packed1, pc.packed2 };
    // **Shifted inward at an edge rather than clamped tap by tap**, which is what keeps the
    // window one whole period and so keeps its colour counts the same as everywhere else. A
    // window that repeated its border column would weigh one colour twice and report the
    // difference as chroma.
    let y0 = min(max(fr - (pc.period_h / 2 - 1), 0), max(pc.height - pc.period_h, 0));
    let x0 = min(max(fc - (pc.period_w / 2 - 1), 0), max(pc.width - pc.period_w, 0));

    var sums = float3(0.0);
    var counts = float3(0.0);
    for (int dy = 0; dy < pc.period_h; dy++) {
        for (int dx = 0; dx < pc.period_w; dx++) {
            let v = in_gat_full[(y0 + dy) * pc.width + (x0 + dx)];
            let colour = cfa_colour(pat, y0 + dy, x0 + dx);
            let hit = float3(
                colour == 0u ? 1.0 : 0.0,
                colour == 1u ? 1.0 : 0.0,
                colour == 2u ? 1.0 : 0.0);
            sums += hit * v;
            counts += hit;
        }
    }
    let m = sums / max(counts, float3(1.0));

    // Normalised so each axis reaches the shrinkage carrying one photosite's sigma, as the 2x2
    // pair does by construction: these are built from means over the period, so without it the
    // threshold reads them as noisier than they are. `Cfa::chroma_gain` says what each divides by.
    c1_h[hp] = (m.x - m.z) / pc.gain_c1;
    c2_h[hp] = (m.x - 2.0 * m.y + m.z) / pc.gain_c2;
    c3_h[hp] = 0.0;
}
