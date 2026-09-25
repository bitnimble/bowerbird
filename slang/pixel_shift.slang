// Gather one burst frame onto the reference's photosite lattice at the field's positions.
// A whole-site tripod offset gives one photosite all tent weight; a fractional handheld offset
// shares it between neighbours. Both use the same gather.

import px;
import light;

struct Params {
    uint width;
    uint height;
    uint frame_width;
    uint frame_height;
    int reference_left;
    int reference_top;
    int frame_left;
    int frame_top;
    int grid_left;
    int grid_top;
    uint grid_width;
    uint grid_height;
    uint is_reference;
    uint colour0;
    uint colour1;
    uint colour2;
    uint colour3;
    uint tile;
    uint pad1;
    uint pad2;
};

[vk::binding(0, 0)] ConstantBuffer<Params> params;
[vk::binding(1, 0)] StructuredBuffer<float> samples;
[vk::binding(2, 0)] StructuredBuffer<float> field;
[vk::binding(3, 0)] RWStructuredBuffer<float> sums;
[vk::binding(4, 0)] RWStructuredBuffer<float> weights;
[vk::binding(5, 0)] RWStructuredBuffer<float> greens;

float2 displacement(int x, int y)
{
    if (params.is_reference != 0) { return float2(0.0, 0.0); }
    let tile_size = measured<Sensor>(params.tile).n;
    let gx = (float(x - params.grid_left) - float(tile_size) * 0.5) / float(tile_size);
    let gy = (float(y - params.grid_top) - float(tile_size) * 0.5) / float(tile_size);
    let ix = int(floor(gx));
    let iy = int(floor(gy));
    let fx = frac(gx);
    let fy = frac(gy);
    let x0 = clamp(ix, 0, int(params.grid_width) - 1);
    let x1 = clamp(ix + 1, 0, int(params.grid_width) - 1);
    let y0 = clamp(iy, 0, int(params.grid_height) - 1);
    let y1 = clamp(iy + 1, 0, int(params.grid_height) - 1);
    let a = (y0 * int(params.grid_width) + x0) * 4;
    let b = (y0 * int(params.grid_width) + x1) * 4;
    let c = (y1 * int(params.grid_width) + x0) * 4;
    let d = (y1 * int(params.grid_width) + x1) * 4;
    let top = lerp(float2(field[a], field[a + 1]), float2(field[b], field[b + 1]), fx);
    let bottom = lerp(float2(field[c], field[c + 1]), float2(field[d], field[d + 1]), fx);
    return lerp(top, bottom, fy);
}

uint colour_at(int x, int y)
{
    let at = (y & 1) * 2 + (x & 1);
    if (at == 0) { return params.colour0; }
    if (at == 1) { return params.colour1; }
    if (at == 2) { return params.colour2; }
    return params.colour3;
}

[shader("compute")]
[numthreads(8, 8, 1)]
void gather(uint3 gid : SV_DispatchThreadID)
{
    if (gid.x >= params.width || gid.y >= params.height) { return; }
    let site = gid.y * params.width + gid.x;
    let sensor_x = params.reference_left + int(gid.x);
    let sensor_y = params.reference_top + int(gid.y);
    let moved = displacement(sensor_x, sensor_y);
    let qx = float(sensor_x - params.frame_left) + moved.x;
    let qy = float(sensor_y - params.frame_top) + moved.y;
    let x0 = int(floor(qx));
    let y0 = int(floor(qy));
    let fx = frac(qx);
    let fy = frac(qy);
    float green_sum = 0.0;
    float green_weight = 0.0;
    for (int y = 0; y <= 1; y++) {
        for (int x = 0; x <= 1; x++) {
            let sx = x0 + x;
            let sy = y0 + y;
            if (sx < 0 || sy < 0 || sx >= int(params.frame_width) || sy >= int(params.frame_height)) { continue; }
            let weight = (x == 0 ? 1.0 - fx : fx) * (y == 0 ? 1.0 - fy : fy);
            let channel = colour_at(sx, sy);
            let value = measured<Level>(samples[sy * int(params.frame_width) + sx]).v;
            sums[site * 3 + channel] += weight * value;
            weights[site * 3 + channel] += weight;
            if (channel == 1) {
                green_sum += weight * value;
                green_weight += weight;
            }
        }
    }
    if (green_weight > 0.0) {
        let green = green_sum / green_weight;
        greens[site * 3] += green_weight;
        greens[site * 3 + 1] += green_sum;
        greens[site * 3 + 2] += green_weight * green * green;
    }
}
