// The rows of workgroups one band of a banded dispatch covers, which `gpu::Recording::banded`
// binds for each band it cuts: a shader it dispatches places its workgroups `first_row` rows
// further down than the band's own dispatch numbers them.
module band;

public struct Band
{
    public uint first_row;
    public uint rows;
};

// `gpu::dispatch::BAND_GROUP`.
[[vk::binding(0, 3)]]
public ConstantBuffer<Band> banding;

// The invocation `dispatched` stands for in the whole dispatch, `tall` invocations to a
// workgroup's column.
public uint3 banded(uint3 dispatched, uint tall)
{
    return uint3(dispatched.x, dispatched.y + banding.first_row * tall, dispatched.z);
}
