// The source pixels a box-averaging resize gives each output pixel, which both sides of the camera
// match's pair are reduced through so neither is sharpened relative to the other.
module footprint;

/// The source pixels output pixel `out` averages: `x0, x1, y0, y1`, half-open, whole pixels.
public int4 box_of(int2 out, int2 source_size, int2 out_size)
{
    let xs = float(source_size.x) / float(out_size.x);
    let ys = float(source_size.y) / float(out_size.y);
    let y0 = int(floor(float(out.y) * ys));
    let y1 = max(int(floor(float(out.y + 1) * ys)), y0 + 1);
    let x0 = int(floor(float(out.x) * xs));
    let x1 = max(int(floor(float(out.x + 1) * xs)), x0 + 1);
    return int4(x0, x1, y0, y1);
}
