// What both of the viewer stage's pipelines draw with.
//
// Two of them because one samples `texture_external`, which Slang has no type for, so that
// pipeline's fragment is hand-written WGSL appended to this. What they must not disagree about is
// where the triangle lands and what it hands the fragment, so that is here rather than in each.
module stage_shared;

public struct Drawn {
    public float4 position : SV_Position;
    public float2 uv : TEXCOORD0;
};

/// One triangle over the whole canvas: a quad is two triangles and a seam down the diagonal.
public Drawn drawn_at(uint at)
{
    float2 corners[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    let corner = corners[at];
    Drawn drawn;
    drawn.position = float4(corner, 0.0, 1.0);
    drawn.uv = float2((corner.x + 1.0) * 0.5, 1.0 - (corner.y + 1.0) * 0.5);
    return drawn;
}
