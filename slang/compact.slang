// An order-keeping compaction, a block to a workgroup.
//
// Each lane takes a contiguous share of its block, so placing the lanes' kept items one after
// another in lane order is the order a single walk of the block would have written them in.
module compact;

public static const int LANES = 64;

groupshared uint lane_kept[LANES];

/// Lane `lane`'s contiguous share of the block `[first, last)`.
public int2 share_of(int first, int last, int lane)
{
    let chunk = (last - first + LANES - 1) / LANES;
    let from = min(first + lane * chunk, last);
    return int2(from, min(from + chunk, last));
}

/// Which of a share's items were kept, a bit each, for a test too dear to run twice. A share holds
/// at most 64 items, so a block at most `64 * LANES`.
public uint2 with_kept(uint2 kept, int i)
{
    return i < 32 ? uint2(kept.x | (1u << uint(i)), kept.y) : uint2(kept.x, kept.y | (1u << uint(i - 32)));
}

public bool is_kept(uint2 kept, int i)
{
    return ((i < 32 ? kept.x >> uint(i) : kept.y >> uint(i - 32)) & 1u) != 0;
}

public uint kept_count(uint2 kept)
{
    return countbits(kept.x) + countbits(kept.y);
}

/// How many the lanes before `lane` kept, given each lane's `kept`, and in `total` the block's.
public uint kept_before(int lane, uint kept, out uint total)
{
    lane_kept[lane] = kept;
    GroupMemoryBarrierWithGroupSync();
    var before = 0u;
    total = 0u;
    for (int j = 0; j < LANES; j++) {
        let k = lane_kept[j];
        if (j < lane) { before += k; }
        total += k;
    }
    GroupMemoryBarrierWithGroupSync();
    return before;
}
