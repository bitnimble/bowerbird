// What `warp.slang` and `composite_gather.slang` both read a frame through: the stencil, the lens's
// per-channel ratio table, and the falloff's lift. The two are held to each other by the fixtures,
// so these are one statement rather than two kept in step.
module lens_gather;

import prelude;
import packed;
import catmull_rom;

/// One channel of a three-codes-a-pixel frame of `size` sampled at `(px, py)`. The caller has
/// checked the point is inside the frame.
///
/// The stencil clamps at the border: the outermost ring has no full neighbourhood and the nearest
/// sample stands in for what is off the edge.
public float tap(StructuredBuffer<uint> frame, uint2 size, float px, float py, uint channel)
{
    let sw = size.x;
    let sh = size.y;
    let x0 = min(uint(px), sw - 2);
    let y0 = min(uint(py), sh - 2);
    let wx = cubic_weights(px - float(x0));
    let wy = cubic_weights(py - float(y0));
    let columns = uint4(max(x0, 1) - 1, x0, min(x0 + 1, sw - 1), min(x0 + 2, sw - 1));
    let rows = uint4(max(y0, 1) - 1, y0, min(y0 + 1, sh - 1), min(y0 + 2, sh - 1));

    var total = 0.0;
    for (uint j = 0; j < 4; j++) {
        var across = 0.0;
        for (uint i = 0; i < 4; i++) {
            let at = (rows[j] * sw + columns[i]) * 3 + channel;
            across += wx[i] * float(half_of(frame[at / 2], at));
        }
        total += wy[j] * across;
    }
    return total;
}

/// Channel `c`'s ratio at a radius, from three of `image::channel_ratio_table` end to end, red then
/// green then blue. `r2` is the radius squared as a fraction of the half-grid's.
public float lens_ratio(StructuredBuffer<float> ratios, float r2, uint c)
{
    uint count;
    uint stride;
    ratios.GetDimensions(count, stride);
    let last = count / 3 - 1;
    let t = r2 * float(last);
    var slot = uint(t);
    if (t >= float(last)) { slot = last - 1; }
    let table = c * (last + 1);
    let low = ratios[table + slot];
    return low + (ratios[table + slot + 1] - low) * (t - float(slot));
}

/// A gain in linear light applied to a PQ signal without leaving PQ: `y = (Y/10000)^m1` is PQ's
/// own intermediate, and `Y' = g·Y` is `y' = g^m1 · y` there, so the `^m1` / `^(1/m1)` pair a
/// round trip would evaluate cancels. `gain_in_y` is that `g^m1`, `tone::gain_in_y`'s.
public float lift_in_pq(float signal, float gain_in_y)
{
    let u = pow(clamp(signal, 0.0, 1.0), 1.0 / PQ_M2);
    // Bounded at 1 because `pq` bounds what it takes the exponent of: without it a gain pushes
    // past 10000 nits and the curve keeps climbing where the transfer saturates - at a gain of
    // 2.8 near white the fold reads 1.108 against the round trip's 1.0.
    let y = min((max(u - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * u)) * gain_in_y, 1.0);
    return pow((PQ_C1 + PQ_C2 * y) / (1.0 + PQ_C3 * y), PQ_M2);
}
