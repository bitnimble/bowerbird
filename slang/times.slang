// An integer times a constant.
//
// **Never `x * 3`.** Adreno's compiler truncates `x` to 24 bits when it multiplies by a constant
// that is not a power of two, and folds `x + x + x` and `(x << 1) + x` into the same: past 2^24, a
// 61MP frame's bottom half is written over its top. Split, neither partial operand reaches 2^24.
// `build.rs` refuses a shader that multiplies by three any other way.
module times;

public uint times(uint x, uint k)
{
    return (((x >> 12) * k) << 12) + (x & 0xfff) * k;
}

public int times(int x, int k)
{
    return int(times(uint(x), uint(k)));
}
