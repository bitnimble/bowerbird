module illuminant;

// DNG's Robertson isotherms keep temperature/tint compatible with Camera Raw sidecars.
static const float4 LOCUS[31] = {
    float4(  0.0, 0.18006, 0.26352,   -0.24341),
    float4( 10.0, 0.18066, 0.26589,   -0.25479),
    float4( 20.0, 0.18133, 0.26846,   -0.26876),
    float4( 30.0, 0.18208, 0.27119,   -0.28539),
    float4( 40.0, 0.18293, 0.27407,   -0.30470),
    float4( 50.0, 0.18388, 0.27709,   -0.32675),
    float4( 60.0, 0.18494, 0.28021,   -0.35156),
    float4( 70.0, 0.18611, 0.28342,   -0.37915),
    float4( 80.0, 0.18740, 0.28668,   -0.40955),
    float4( 90.0, 0.18880, 0.28997,   -0.44278),
    float4(100.0, 0.19032, 0.29326,   -0.47888),
    float4(125.0, 0.19462, 0.30141,   -0.58204),
    float4(150.0, 0.19962, 0.30921,   -0.70471),
    float4(175.0, 0.20525, 0.31647,   -0.84901),
    float4(200.0, 0.21142, 0.32312,   -1.0182),
    float4(225.0, 0.21807, 0.32909,   -1.2168),
    float4(250.0, 0.22511, 0.33439,   -1.4512),
    float4(275.0, 0.23247, 0.33904,   -1.7298),
    float4(300.0, 0.24010, 0.34308,   -2.0637),
    float4(325.0, 0.24702, 0.34655,   -2.4681),
    float4(350.0, 0.25591, 0.34951,   -2.9641),
    float4(375.0, 0.26400, 0.35200,   -3.5814),
    float4(400.0, 0.27218, 0.35407,   -4.3633),
    float4(425.0, 0.28039, 0.35577,   -5.3762),
    float4(450.0, 0.28863, 0.35714,   -6.7262),
    float4(475.0, 0.29685, 0.35823,   -8.5955),
    float4(500.0, 0.30505, 0.35907,  -11.324),
    float4(525.0, 0.31320, 0.35968,  -15.628),
    float4(550.0, 0.32129, 0.36011,  -23.325),
    float4(575.0, 0.32931, 0.36038,  -40.770),
    float4(600.0, 0.33724, 0.36051, -116.45)
};

static const float TINT_SCALE = -3000.0;

public float2 xy_of(float temperature, float tint)
{
    let mireds = 1.0e6 / max(temperature, 1.0);
    var index = 29;
    for (int i = 0; i < 29; i = i + 1) {
        if (mireds < LOCUS[i + 1][0]) {
            index = i;
            break;
        }
    }

    let lo = LOCUS[index];
    let hi = LOCUS[index + 1];
    let f = (hi[0] - mireds) / (hi[0] - lo[0]);
    var u = lo[1] * f + hi[1] * (1.0 - f);
    var v = lo[2] * f + hi[2] * (1.0 - f);

    let lo_length = sqrt(1.0 + lo[3] * lo[3]);
    let hi_length = sqrt(1.0 + hi[3] * hi[3]);
    var du = f / lo_length + (1.0 - f) / hi_length;
    var dv = lo[3] * f / lo_length + hi[3] * (1.0 - f) / hi_length;
    let length = sqrt(du * du + dv * dv);
    du = du / length;
    dv = dv / length;

    let offset = tint / TINT_SCALE;
    u = u + du * offset;
    v = v + dv * offset;

    let denominator = u - 4.0 * v + 2.0;
    return float2(1.5 * u / denominator, v / denominator);
}

public float2 temperature_tint_of(float2 xy)
{
    let denominator = 1.5 - xy.x + 6.0 * xy.y;
    if (abs(denominator) < 1.0e-12) {
        return float2(6500.0, 0.0);
    }
    let u = 2.0 * xy.x / denominator;
    let v = 3.0 * xy.y / denominator;

    float last_distance = 0.0;
    float last_du = 0.0;
    float last_dv = 0.0;
    for (int index = 1; index < 31; index = index + 1) {
        let row = LOCUS[index];
        let reach = sqrt(1.0 + row[3] * row[3]);
        var du = 1.0 / reach;
        var dv = row[3] / reach;
        var uu = u - row[1];
        var vv = v - row[2];
        var distance = -uu * dv + vv * du;

        if (distance <= 0.0 || index == 30) {
            distance = max(-distance, 0.0);
            float f = 0.0;
            if (index != 1) {
                f = distance / (last_distance + distance);
            }
            let before = LOCUS[index - 1];
            let mireds = before[0] * f + row[0] * (1.0 - f);
            uu = u - (before[1] * f + row[1] * (1.0 - f));
            vv = v - (before[2] * f + row[2] * (1.0 - f));
            du = du * (1.0 - f) + last_du * f;
            dv = dv * (1.0 - f) + last_dv * f;
            let length = sqrt(du * du + dv * dv);
            return float2(
                1.0e6 / max(mireds, 1.0e-9),
                (uu * du / length + vv * dv / length) * TINT_SCALE);
        }
        last_distance = distance;
        last_du = du;
        last_dv = dv;
    }
    return float2(6500.0, 0.0);
}

public float3 xyz_of(float2 xy)
{
    let y = max(xy.y, 1.0e-6);
    return float3(xy.x / y, 1.0, (1.0 - xy.x - xy.y) / y);
}
