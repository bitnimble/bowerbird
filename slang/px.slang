// Pixels that know which picture they are pixels of, and what its pixels are the size of.
//
// `native/rawshim/src/px.rs` on this side of the boundary, and for the same reason: naming the
// space says which picture a number is a number of, and does not say how finely that picture was
// sampled. The frame a grade writes is sampled at whatever the rendition asked for, so a count of
// its pixels is a different share of the same photograph at 3840 than at a sensor's own size -
// which is how a colour footprint written down as four pixels came to cover two and a half times
// as much of the viewer's rendition as of the editor's frame at 1:1.
//
// So the spaces divide, exactly as they do on the host:
//
// - A space whose pixels are one fixed size is `IAbsolute`, and `exact` will take a constant
//   number of them.
// - A space sized by an output is not, and there is no `exact` for it. A distance comes from that
//   frame's own extent through `measured`, or from a `Share` of the picture resolved against that
//   extent - so two distances in one shader trace back to one frame.
//
// **Nothing here survives into the WGSL.** A `Span` is one `uint` in a struct with no methods that
// touch memory, and Slang monomorphises the generic away, so what a host binds and what a lane
// reads are the numbers they always were. `the_generic_pixels_cost_nothing` holds that.
//
// **Every spatial constant in the pipeline, classified, because several of the kinds look
// alike in a diff.** A new one belongs in a row here before it belongs in a shader:
//
// - *A share of the photograph.* `detail.slang`'s `GUIDE_RADIUS` and `FINE_SIGMA`, the chroma
//   grid's shrink, `composite_features`' `REACH`, and `repair`'s `MOST_OFFERED_FEATHER`. These are `Share`, and the reason the type
//   exists: written as a count of the frame's pixels they mean a different picture at every
//   rendition size, which is what the colour smoothing did - and what the descriptor window did
//   the moment a burst began searching on half the plane a pan does.
// - *Absolute, on the mosaic.* `rcd.slang`'s `REACH_*`, `galosh`'s windows, `defocus.slang`'s
//   `STRIDE`. A photosite is a photosite, so a count of them is a quantity and `exact` takes it.
// - *Scale-exact by construction.* `chroma_smooth`'s `SIGMA` and `REACH` in texels of a grid that
//   is itself a share, `detail`'s `DETAIL_LONG` at 512, `patch_stats`'s `PATCH` on the fit's own
//   1280 plane. A working plane of fixed size has fixed pixels, so constants in it are safe.
// - *A pixel of whatever is drawn, on purpose.* `assembly_weight::W_HIGH_PX`, the high band's two
//   render pixels: what it smooths is the staircase a rasteriser leaves, which is one pixel at
//   every size, so a share of the picture would be the wrong answer at every size but one.
// - *A distance in units that are not pixels of anything.* `dust.slang`'s `SPAN` is 2.5 *blob
//   radii*, a multiplier of a measured axis; `sharpen.slang`'s `RADIUS` is a count of *taps*,
//   whose sigma is what spans a picture. Each carries its own unit, `BlobRadius` and `Tap`, even
//   where one constant is the unit's only inhabitant - because a distance that reads as pixels
//   and is not is the one a later edit turns into pixels by accident. `repair_solve`'s `GROW`,
//   `REACH` and `GUARD` are the same kind: counts of cells, a cell being `repair::CELLS_ACROSS`
//   of the loop the reader drew, so a dust spot and a person are searched alike. They reach a
//   shader only resolved, as `repair.slang`'s `cell` and `feather`.
//
// **A struct constant used inside a loop wants its number hoisted first.** Slang synthesises an
// initializer per use site, and a struct returned by value under a loop is a call Metal drops
// once enough is live - `no_struct_returns_under_a_loop` refuses it, and `sharpen.slang` takes
// `RADIUS.n` once above its stencil for exactly that reason. The unit is asserted at the
// declaration; what walks the loop is the number.
module px;

/// A picture a number can be a number of.
public interface ISpace {}

/// A space whose pixels are one fixed size, so a count of them is a quantity rather than a ratio.
///
/// The photograph decides these and an output does not: a photosite is a photosite whatever
/// anyone renders afterwards, where the frame a grade writes has pixels as large as the rendition
/// is small.
public interface IAbsolute : ISpace {}

/// The sensor's own pixels, before any crop.
public struct Sensor : IAbsolute {}

/// The upright, cropped photograph at the sensor's full resolution.
public struct Photograph : IAbsolute {}

/// The frame a decode actually produced, which a half-size decode halves.
public struct Drawn : IAbsolute {}

/// What the grade writes, once the reader's crop and straighten have been applied.
public struct Output : ISpace {}

/// The working texture the presence sliders' guided filter is built on.
public struct Texel : ISpace {}

/// The stage the editor draws onto, in the pixels the browser hands out.
public struct Canvas : ISpace {}

/// The camera match's own plane, a fixed 1280 across the photograph.
public struct FitPlane : IAbsolute {}

/// The plane a composite's geometry search runs on: the frames' embedded JPEGs, brought to one
/// size.
///
/// **Deliberately not `IAbsolute`.** Its long edge is the caller's choice - `composite_align::Kind`
/// asks for 1616 for a pan and 808 for a burst, and a body whose embedded JPEG is shorter brings
/// the whole set down to its own size - so a count of these pixels is a ratio, and a constant in
/// them describes a different amount of picture in each case.
public struct Search : ISpace {}

// **Units that are distances and are not pixels of anything.** Each gets a marker even where one
// constant is its only inhabitant: they cost nothing, and the ones that read as pixels and are not
// are exactly the ones a later edit converts into pixels by accident.

/// Taps of a kernel. A count of samples a stencil reads, not a distance across a picture: five of
/// these is five taps whatever the sigma they are weighing, and the sigma is what carries the
/// scale (`image::deconvolve_split` clamps it to what five are honest for).
public struct Tap : IAbsolute {}

/// Multiples of a particle's own measured axis, which is what `dust.slang` reaches out in. The
/// axis is in pixels and this is not; two and a half of these is a different number of pixels for
/// every blob on the sensor.
public struct BlobRadius : IAbsolute {}

/// Buckets of a histogram, indexed along a value and never a place.
public struct Bin : IAbsolute {}

/// A distance, in the pixels of `S`: a width, a reach, a stride.
public struct Span<S : ISpace> {
    public uint n;
}

/// A distance in the units of `S` that need not be whole: a sigma, a radius in blob axes, a stop.
///
/// Beside `Span` rather than replacing it because the two round differently and a picture is
/// where that shows - a footprint of two and a half texels reads three of them and covers two and
/// a half, and which of those a caller wanted is the sort of thing only a name settles.
public struct Extent<S : ISpace> {
    public float d;
}

/// A number entering an absolute space, at a boundary that knows which one it is.
public Extent<S> exactly<S : IAbsolute>(float d)
{
    Extent<S> extent;
    extent.d = d;
    return extent;
}

/// A number entering an absolute space, at a boundary that knows which one it is.
public Span<S> exact<S : IAbsolute>(uint n)
{
    Span<S> span;
    span.n = n;
    return span;
}

/// A frame that exists, measured: the one way a space with no fixed pixel size gets a number.
///
/// Rare on purpose. It belongs where a frame's extent arrives from the uniform and nowhere else,
/// because everything downstream of it can be derived.
public Span<S> measured<S : ISpace>(uint n)
{
    Span<S> span;
    span.n = n;
    return span;
}

/// A fraction of a picture's long edge, belonging to no space until it is given one.
public struct Share {
    public float fraction;

    /// This share of `long`, rounded up and never zero: a footprint of no pixels is not one.
    public Span<S> over<S : ISpace>(Span<S> long)
    {
        Span<S> span;
        span.n = max(uint(ceil(float(long.n) * this.fraction)), 1u);
        return span;
    }
}

public Share share(uint numerator, uint denominator)
{
    Share s;
    s.fraction = float(numerator) / float(denominator);
    return s;
}

public Span<S> plus<S : ISpace>(Span<S> a, Span<S> b)
{
    Span<S> span;
    span.n = a.n + b.n;
    return span;
}

public Span<S> times<S : ISpace>(Span<S> a, uint by)
{
    Span<S> span;
    span.n = a.n * by;
    return span;
}
