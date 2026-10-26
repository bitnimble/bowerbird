// The multi-scale shrinkage's shared shape: a plane per photosite of a site, each site of the
// stabilised mosaic (2x2 on Bayer, 3x3 on X-Trans) taken through an orthonormal transform
// (`galosh::site_transform`), so the unit noise the GAT left stays unit and white in every plane.
//
// Plane 0 is the site's mean; 1 and 2 its red-blue and magenta-green differences; the rest the
// detail inside the site, each colour's photosites against their own mean.
module pyramid;

public static const int MAX_PLANES = 9;

/// The levels from the sites down, each a 2x2 box of the one above.
public static const int LEVELS = 4;

/// One workgroup of `pyr_shrink`: the pixels it writes, and the 8x8 blocks at stride 4 that cover
/// them, which reach 4 pixels past the tile on every side.
public static const int TILE = 28;
public static const int BLOCK = 8;
public static const int STRIDE = 4;

/// What every shrinkage pass reads. A level shrunk as several passes over offset block grids adds
/// each pass's `share`.
public struct Level {
    public int w;
    public int h;
    public int offset_x;
    public int offset_y;
    public int tiles_x;
    /// Planes before it are guides, read as they came.
    public int first;
    public float variance;
    public float share;
    /// In multiples of `variance`: plane 0's, then every other plane's.
    public float luma_strength;
    public float colour_strength;
    public int accumulate;
    /// Share of the noisy plane handed back; the same at every level.
    public float kept;
};

/// What `pyr_pack` and `pyr_restore` read: the mosaic's extent, the first two levels', the site's
/// side in photosites, the sites one period spans across and down, the period's colours as
/// `prelude::Pattern` packs them, `prelude::to_green`'s red and blue, and the share of its luma
/// noise a site keeps.
public struct Sites {
    public int width;
    public int height;
    public int w0;
    public int h0;
    public int w1;
    public int h1;
    public int side;
    public int across;
    public int down;
    public uint packed0;
    public uint packed1;
    public uint packed2;
    public float red_to_green;
    public float blue_to_green;
    public float luma_kept;
};

/// Where the site at (x, y)'s transform starts in the table: one period's sites hold one each, a
/// `MAX_PLANES` row per plane, `across` sites to a period's row and `down` to its column.
public int transform_at(int x, int y, int across, int down)
{
    return ((y % down) * across + x % across) * MAX_PLANES * MAX_PLANES;
}

static const float DCT[64] = {
    0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339, 0.35355339,
    0.49039264, 0.41573481, 0.27778512, 0.09754516, -0.09754516, -0.27778512, -0.41573481, -0.49039264,
    0.46193977, 0.19134172, -0.19134172, -0.46193977, -0.46193977, -0.19134172, 0.19134172, 0.46193977,
    0.41573481, -0.09754516, -0.49039264, -0.27778512, 0.27778512, 0.49039264, 0.09754516, -0.41573481,
    0.35355339, -0.35355339, -0.35355339, 0.35355339, 0.35355339, -0.35355339, -0.35355339, 0.35355339,
    0.27778512, -0.49039264, 0.09754516, 0.41573481, -0.41573481, -0.09754516, 0.49039264, -0.27778512,
    0.19134172, -0.46193977, 0.46193977, -0.19134172, -0.19134172, 0.46193977, -0.46193977, 0.19134172,
    0.09754516, -0.27778512, 0.41573481, -0.49039264, 0.49039264, -0.41573481, 0.27778512, -0.09754516,
};

/// sin^2 over the block: a pixel's two overlapping blocks along an axis weigh 1 between them.
public static const float WINDOW[8] = {
    0.03806023, 0.30865828, 0.69134172, 0.96193977, 0.96193977, 0.69134172, 0.30865828, 0.03806023,
};

/// The orthonormal 8-point DCT-II, in place.
void dct8(inout float v[8])
{
    float s[4];
    float d[4];
    [ForceUnroll]
    for (int n = 0; n < 4; n++) {
        s[n] = v[n] + v[7 - n];
        d[n] = v[n] - v[7 - n];
    }
    let e0 = s[0] + s[3];
    let e1 = s[1] + s[2];
    let f0 = s[0] - s[3];
    let f1 = s[1] - s[2];
    v[0] = DCT[0] * (e0 + e1);
    v[4] = DCT[32] * (e0 - e1);
    v[2] = DCT[16] * f0 + DCT[17] * f1;
    v[6] = DCT[48] * f0 + DCT[49] * f1;
    [ForceUnroll]
    for (int k = 1; k < 8; k += 2) {
        v[k] = DCT[k * 8] * d[0] + DCT[k * 8 + 1] * d[1] + DCT[k * 8 + 2] * d[2] + DCT[k * 8 + 3] * d[3];
    }
}

void idct8(inout float v[8])
{
    let a = DCT[0] * v[0] + DCT[32] * v[4];
    let b = DCT[0] * v[0] - DCT[32] * v[4];
    let p = DCT[16] * v[2] + DCT[48] * v[6];
    let q = DCT[17] * v[2] + DCT[49] * v[6];
    float e[4] = { a + p, b + q, b - q, a - p };
    float o[4];
    [ForceUnroll]
    for (int n = 0; n < 4; n++) {
        o[n] = DCT[8 + n] * v[1] + DCT[24 + n] * v[3] + DCT[40 + n] * v[5] + DCT[56 + n] * v[7];
    }
    [ForceUnroll]
    for (int n = 0; n < 4; n++) {
        v[n] = e[n] + o[n];
        v[7 - n] = e[n] - o[n];
    }
}

/// The orthonormal 8x8 DCT-II of a block, rows then columns.
public void dct_forward(inout float b[64])
{
    float t[8];
    [ForceUnroll]
    for (int r = 0; r < 8; r++) {
        [ForceUnroll]
        for (int i = 0; i < 8; i++) { t[i] = b[r * 8 + i]; }
        dct8(t);
        [ForceUnroll]
        for (int i = 0; i < 8; i++) { b[r * 8 + i] = t[i]; }
    }
    [ForceUnroll]
    for (int c = 0; c < 8; c++) {
        [ForceUnroll]
        for (int i = 0; i < 8; i++) { t[i] = b[i * 8 + c]; }
        dct8(t);
        [ForceUnroll]
        for (int i = 0; i < 8; i++) { b[i * 8 + c] = t[i]; }
    }
}

public void dct_inverse(inout float b[64])
{
    float t[8];
    [ForceUnroll]
    for (int c = 0; c < 8; c++) {
        [ForceUnroll]
        for (int i = 0; i < 8; i++) { t[i] = b[i * 8 + c]; }
        idct8(t);
        [ForceUnroll]
        for (int i = 0; i < 8; i++) { b[i * 8 + c] = t[i]; }
    }
    [ForceUnroll]
    for (int r = 0; r < 8; r++) {
        [ForceUnroll]
        for (int i = 0; i < 8; i++) { t[i] = b[r * 8 + i]; }
        idct8(t);
        [ForceUnroll]
        for (int i = 0; i < 8; i++) { b[r * 8 + i] = t[i]; }
    }
}

/// A level's plane `p`, laid out plane after plane.
public int at_plane(int p, int x, int y, int w, int h)
{
    return (p * h + y) * w + x;
}

/// Reflected about the edge pixel's outer side.
public int mirrored(int i, int n)
{
    let m = i < 0 ? -1 - i : (i >= n ? 2 * n - 1 - i : i);
    return clamp(m, 0, n - 1);
}

/// The two coarse samples a fine pixel interpolates between, and the weight on the second: a
/// coarse pixel's centre sits at fine `2j + 0.5`.
public void bilinear(int i, int n, out int j0, out int j1, out float f)
{
    let at = (float(i) + 0.5) * 0.5 - 0.5;
    let low = int(floor(at));
    f = at - float(low);
    j0 = clamp(low, 0, n - 1);
    j1 = clamp(low + 1, 0, n - 1);
}

/// The difference of two coarse planes of one shape at fine pixel (x, y), interpolated.
public float upsampled_difference(
    StructuredBuffer<float> coarse,
    StructuredBuffer<float> taken,
    int p, int x, int y, int w, int h)
{
    int x0, x1, y0, y1;
    float fx, fy;
    bilinear(x, w, x0, x1, fx);
    bilinear(y, h, y0, y1, fy);
    let d00 = coarse[at_plane(p, x0, y0, w, h)] - taken[at_plane(p, x0, y0, w, h)];
    let d10 = coarse[at_plane(p, x1, y0, w, h)] - taken[at_plane(p, x1, y0, w, h)];
    let d01 = coarse[at_plane(p, x0, y1, w, h)] - taken[at_plane(p, x0, y1, w, h)];
    let d11 = coarse[at_plane(p, x1, y1, w, h)] - taken[at_plane(p, x1, y1, w, h)];
    return lerp(lerp(d00, d10, fx), lerp(d01, d11, fx), fy);
}
