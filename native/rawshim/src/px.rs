//! Pixels that know which picture they are pixels of, and whether they are a place or a distance.
//!
//! **Six spaces, all of them `usize` until now.** A photograph is decoded at one of two
//! resolutions, cropped and straightened into a third, blurred on a working texture of a fourth,
//! drawn onto a canvas of a fifth, and read off a sensor whose own pixels are a sixth - and every
//! one of those was a bare number, freely assignable to any other. The failures that produced this
//! module were all the same sentence written with the wrong noun: a window's origin in the
//! photograph's pixels subtracted from an offset in the decode's, a photograph handed to a grade
//! reading a half-size frame, an aberration looked up at a resolution it was not fitted at. None of
//! them is visible in a diff; each is a picture that comes out wrong somewhere a test was not
//! looking.
//!
//! **And a place is not a distance.** `left + width` is the far edge; `left - window_left` is how
//! far in the tile sits. Both are `usize` and only one of them is a coordinate, so the arithmetic
//! that mixes them is as silent as the arithmetic that mixes spaces. [`Place`] and [`Span`] are an
//! affine pair: two places make a span, a place and a span make a place, and a place plus a place
//! is not anything. [`Coordinate`] and [`Extent`] are the same pair between pixels, for a loop whose
//! vertices fall where they fall.
//!
//! **A space alone does not make two numbers commensurable, and pretending it did cost a
//! picture.** Naming the space says which picture a number is a number of; it does not say how
//! finely that picture was sampled. [`Photograph`] is one resolution and a count of its pixels
//! means one thing. The frame a grade writes is whatever size the rendition asked for, so twenty
//! four of *its* pixels is a different share of the same photograph at 3840 than at a 61MP
//! sensor's own size - and the colour smoothing that was written down as a constant number of
//! them smoothed the viewer's rendition over two and a half times as much of itself as the
//! editor smoothed the same photograph at 1:1. Every number in that chain was in the space it
//! claimed. What it was not was the same size in two of them.
//!
//! So the spaces divide, and the division is the whole of what this module now guarantees:
//!
//! - A space whose pixels are one fixed size is [`Absolute`], and a constant number of them can
//!   be written down - [`Span::exact`] takes one.
//! - A space whose pixels are whatever an output asked for is not, and there is no way to write
//!   a distance in it at all. One comes from that frame's own extent, or from a [`Share`] of the
//!   picture resolved against that extent - so any two distances in scope trace back to the same
//!   frame, which is the property a shared type was supposed to mean.
//!
//! Nothing here costs a byte or an instruction - the markers are uninhabited and the phantom is a
//! function pointer - and nothing here can be constructed by accident. A number becomes a pixel at
//! a boundary that names the space it is entering, and stops being one at [`Span::raw`] or
//! [`Place::raw`], which are deliberately ugly to read and easy to grep.

use std::marker::PhantomData;

/// The sensor's own pixels, before any crop: what rawler reads and `crop_area` is named in.
pub enum Sensor {}

/// The upright, cropped photograph at the sensor's full resolution.
///
/// **What a request names**, because it is what a reader points at: a crop rectangle, a loupe's
/// tile, the frame a stored analysis describes.
pub enum Photograph {}

/// The frame the corrections run on: what a decode produced, which [`crate::view::Scale::Half`]
/// halves, or that resized to a size neither resolution gives ([`Decoded`]).
///
/// Equal to [`Photograph`] whenever the scale is `Full`, which is most of the time and is exactly
/// what made the two so easy to confuse.
pub enum Drawn {}

/// What a decode produced, where a render resizes it before correcting it
/// (`tile::TileRequest::drawn`). Everywhere nothing resizes, the decode's frame *is* [`Drawn`].
pub enum Decoded {}

/// What the grade writes, once the reader's crop and straighten have been applied.
///
/// Not a sub-rectangle of [`Drawn`]: a straighten's bounding box can be larger than the frame it
/// was cut from, which is how a browser sized a buffer off the wrong one and returned a picture
/// with an unwritten tail.
pub enum Output {}

/// The working texture the presence sliders' guided filter is built on.
pub enum Texel {}

/// The stage the editor draws onto, in the pixels the browser hands out.
pub enum Canvas {}

pub enum PrintUnit {}
pub enum Millimetre {}

/// The camera match's own plane, a fixed 1280 across the photograph.
pub enum FitPlane {}

/// The grid an edit document writes a position on: [`STORED_LONG`] steps across the photograph's
/// long edge, and the short edge in proportion.
///
/// **Across the long edge, not a fraction of each axis** as the crop is written: what is stored
/// here is geometry the solve measures distances in, and on a grid of one fraction per axis a
/// hundred steps across and a hundred down are different lengths on every photograph that is not
/// square. [`FitPlane`]'s shape, for [`FitPlane`]'s reason - a fixed plane has fixed pixels.
pub enum Stored {}

/// The steps across the long edge [`Stored`] divides a photograph into: sixteen bits, which across
/// a 60MP frame's long edge is 0.15 of a photosite, and in a document a five-digit integer rather
/// than a float's decimal expansion.
pub const STORED_LONG: usize = 65535;

/// The plane a composite's geometry search runs on: the frames' embedded JPEGs, brought to one
/// size.
///
/// **Deliberately not [`Absolute`]**: the long edge is `composite_align::Kind`'s choice - 1616 for
/// a pan and 808 for a burst - and a body whose embedded JPEG is shorter brings the whole set down
/// to its own size. So a distance here is a ratio until a [`Share`] gives it a plane, which is how
/// `composite_align::Aligned::radial` leaves it.
pub enum Search {}

/// A composite's canvas at scale 1, which its recipe sizes and every window of it is cut from.
/// Fixed by the recipe rather than by whatever is being rendered, which is what makes it
/// [`Absolute`] where [`Canvas`] is not.
pub enum Composite {}

/// The plane an assembly's analysis runs on: a fixed `ANALYSIS_LONG` across the composite.
///
/// [`Absolute`] because that number is the pipeline's and not the caller's - every §3 threshold
/// that reads as so-many-pixels is so many of these. **The plane the align's own search runs on is
/// not this one and is not absolute**: `composite_align::Kind` chooses its long edge, so a number
/// in its pixels is a ratio and has to be written as a [`Share`] before it can become one of these.
pub enum Analysis {}

/// The mask §3.4's markers and §3.5's cut are walked on: [`Analysis`] divided by `SHRINK`.
///
/// Its own space rather than a scale of that one, because the two are a division apart and the
/// division is the sort of thing that gets applied twice or not at all. A corridor, a reach and a
/// band depth are all counted in these.
pub enum Shrunk {}

/// A pinned picture's own pixels (`snapshot.rs`): the fixture file, sized once by the test that
/// pins it, as [`FitPlane`] is sized once by the fit.
pub enum Pinned {}

// **Units that are distances and are not pixels of anything.** Each gets a marker even where one
// constant is its only inhabitant: they cost nothing, and the ones that read as pixels and are not
// are exactly the ones a later edit converts into pixels by accident.

/// Taps of a kernel: how many samples a stencil reads, not how much picture they span. What
/// carries the scale is the sigma they weigh, which [`crate::image::deconvolve_split`] composes
/// per scale and clamps to what five taps are honest for.
pub enum Tap {}

/// Multiples of a particle's own measured axis, which is what `dust.slang` reaches out in. The
/// axis is in pixels and this is not, so the same 2.5 is a different reach for every blob.
pub enum BlobRadius {}

/// Buckets of a histogram, indexed along a value and never a place.
pub enum Bin {}

/// A space whose pixels are one fixed size, so a count of them is a quantity rather than a ratio.
///
/// **The photograph decides these and an output does not.** A sensor pixel is a photosite and a
/// photograph pixel is one of those upright; a dust particle is so many of them whatever anyone
/// renders afterwards. The frame a grade writes has no such anchor - its pixels are as large as
/// the rendition is small - and neither does the working texture or the canvas, both of which are
/// sized from it. Those get no constants: see [`Share`].
pub trait Absolute {}
impl Absolute for Sensor {}
impl Absolute for PrintUnit {}
impl Absolute for Millimetre {}
impl Absolute for Photograph {}
impl Absolute for Drawn {}
impl Absolute for Decoded {}
impl Absolute for FitPlane {}
impl Absolute for Stored {}
impl Absolute for Composite {}
impl Absolute for Analysis {}
impl Absolute for Shrunk {}
impl Absolute for Pinned {}
impl Absolute for Tap {}
impl Absolute for BlobRadius {}
impl Absolute for Bin {}

/// A distance, in the pixels of `S`: a width, a height, a reach, a stride.
pub struct Span<S>(usize, PhantomData<fn() -> S>);

/// A distance in the units of `S` that need not be whole: a sigma, a radius in blob axes, a stop.
///
/// Beside [`Span`] rather than replacing it because the two round differently and a picture is
/// where that shows - a footprint of two and a half texels reads three of them and covers two and
/// a half, and which of those a caller wanted is the sort of thing only a name settles.
pub struct Extent<S>(f64, PhantomData<fn() -> S>);

impl<S: Absolute> Extent<S> {
    pub const fn exactly(value: f64) -> Self {
        Extent(value, PhantomData)
    }
}

impl<S> Extent<S> {
    /// A frame that exists, measured. See [`Span::measured`].
    pub const fn measured(value: f64) -> Self {
        Extent(value, PhantomData)
    }

    /// The number again, for a uniform, an FFI or an index. Greppable, as [`Span::raw`] is.
    pub const fn raw(self) -> f64 {
        self.0
    }

    /// The nearer and the further of two distances **in the same space**, which is the whole of
    /// what these add over `f64::min`: the bound is what stops one plane's number capping
    /// another's.
    pub fn min(self, other: Self) -> Self {
        Extent(self.0.min(other.0), PhantomData)
    }

    pub fn max(self, other: Self) -> Self {
        Extent(self.0.max(other.0), PhantomData)
    }

    /// The same distance on another picture of the same scene. See [`Coordinate::onto`].
    pub fn onto<T>(self, from: Span<S>, to: Span<T>) -> Extent<T> {
        let whole = from.0 as f64;
        Extent(
            match whole > 0.0 {
                true => self.0 / whole * to.0 as f64,
                false => 0.0,
            },
            PhantomData,
        )
    }
}

impl<S> Clone for Extent<S> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<S> Copy for Extent<S> {}
impl<S> PartialEq for Extent<S> {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl<S> PartialOrd for Extent<S> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.0.partial_cmp(&other.0)
    }
}
impl<S> std::fmt::Debug for Extent<S> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{}", self.0)
    }
}

/// The long edge every bar written as so-many-pixels was measured against: a RAW's embedded
/// preview, which is what a plane was until one could also be a grid tile.
pub const TUNED_ON: usize = 1616;

/// A fraction of a picture's long edge, belonging to no space until it is given one.
///
/// **The only way to write down a distance that is not [`Absolute`].** A footprint that should
/// cover the same share of a photograph at every size is one number - a 960th of the long edge -
/// and it becomes pixels only against the extent it is a share of. Written that way it cannot be
/// resolved against the wrong frame, because resolving it needs a frame at all.
#[derive(Clone, Copy, PartialEq, PartialOrd, Debug)]
pub struct Share(f64);

impl Share {
    /// `numerator` parts in `denominator` of the long edge.
    pub const fn of(numerator: usize, denominator: usize) -> Share {
        Share(numerator as f64 / denominator as f64)
    }

    /// A share measured off something rather than written down: `part` of `whole`.
    ///
    /// For a number that arrived in the pixels of a plane whose size was somebody's choice - the
    /// align's search plane, say - which is the one shape a distance can have here and not be
    /// [`Absolute`].
    pub fn measured(part: f64, whole: f64) -> Share {
        Share(if whole > 0.0 { part / whole } else { 0.0 })
    }

    /// This share of `long`, rounded up and never zero: a footprint of no pixels is not one.
    pub fn over<S>(self, long: Span<S>) -> Span<S> {
        Span(
            ((long.0 as f64 * self.0).ceil() as usize).max(1),
            PhantomData,
        )
    }

    /// The same, exactly and unrounded: for a share that is being *compared* with a bound rather
    /// than used to size something, where rounding up to one pixel would answer the wrong question.
    pub fn across<S>(self, long: Span<S>) -> Extent<S> {
        Extent(long.0 as f64 * self.0, PhantomData)
    }

    pub const fn raw(self) -> f64 {
        self.0
    }
}

/// A position, in the pixels of `S`: a left edge, a top edge, an origin.
pub struct Place<S>(usize, PhantomData<fn() -> S>);

// Written out rather than derived: `derive` would bound every impl on `S`, and the markers are
// uninhabited on purpose so that nothing can hold one.
macro_rules! plain {
    ($name:ident) => {
        impl<S> Clone for $name<S> {
            fn clone(&self) -> Self {
                *self
            }
        }
        impl<S> Copy for $name<S> {}
        impl<S> PartialEq for $name<S> {
            fn eq(&self, other: &Self) -> bool {
                self.0 == other.0
            }
        }
        impl<S> Eq for $name<S> {}
        impl<S> PartialOrd for $name<S> {
            fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
                Some(self.cmp(other))
            }
        }
        impl<S> Ord for $name<S> {
            fn cmp(&self, other: &Self) -> std::cmp::Ordering {
                self.0.cmp(&other.0)
            }
        }
        impl<S> std::hash::Hash for $name<S> {
            fn hash<H: std::hash::Hasher>(&self, into: &mut H) {
                self.0.hash(into);
            }
        }
        impl<S> Default for $name<S> {
            fn default() -> Self {
                $name(0, PhantomData)
            }
        }
        impl<S> std::fmt::Debug for $name<S> {
            fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(out, "{}", self.0)
            }
        }
        impl<S: Absolute> $name<S> {
            /// A number entering this space, at a boundary that knows which one it is.
            ///
            /// Only where the space is [`Absolute`]. Elsewhere a number is not a distance until
            /// it is a [`Share`] of a frame, and this is the compile error that says so.
            pub const fn exact(value: usize) -> Self {
                $name(value, PhantomData)
            }
        }

        impl<S> $name<S> {
            /// A frame that exists, measured: the one way a space with no fixed pixel size gets
            /// a number at all.
            ///
            /// **Rare and greppable, as [`Span::raw`] is.** It should appear where a frame is
            /// created or received and nowhere else, because everything downstream of it can be
            /// derived - a footprint from a [`Share`], an edge from the size. A second one in the
            /// same function is two frames being described, which is the mistake this module
            /// exists to make visible.
            pub const fn measured(value: usize) -> Self {
                $name(value, PhantomData)
            }

            /// The same, for this module's own arithmetic. Private on purpose: a caller that
            /// could reach it could write a constant into a space that has no fixed pixel size,
            /// which is the whole of what the split above prevents.
            const fn new(value: usize) -> Self {
                $name(value, PhantomData)
            }

            /// The number again, for a uniform, an FFI or an index.
            ///
            /// Named to be greppable: every call is a place where the type stops helping.
            pub const fn raw(self) -> usize {
                self.0
            }

            pub fn min(self, other: Self) -> Self {
                $name(self.0.min(other.0), PhantomData)
            }

            pub fn max(self, other: Self) -> Self {
                $name(self.0.max(other.0), PhantomData)
            }
        }
    };
}
plain!(Span);
plain!(Place);

impl<S> Span<S> {
    pub const ZERO: Span<S> = Span::new(0);

    pub fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn div_ceil(self, by: usize) -> Span<S> {
        Span::new(self.0.div_ceil(by))
    }

    /// Down to a whole multiple of `step`, which is what a texel grid asks of a window's origin.
    pub fn floor_to(self, step: Span<S>) -> Span<S> {
        match step.0 {
            0 => self,
            step => Span::new(self.0 / step * step),
        }
    }
}

impl<S> Place<S> {
    pub const ORIGIN: Place<S> = Place::new(0);

    /// Down to a whole multiple of `step`, in the same space.
    pub fn floor_to(self, step: Span<S>) -> Place<S> {
        match step.0 {
            0 => self,
            step => Place::new(self.0 / step * step),
        }
    }
}

/// Two places make a distance. Saturating, as the `usize` it replaces was.
impl<S> std::ops::Sub for Place<S> {
    type Output = Span<S>;
    fn sub(self, from: Place<S>) -> Span<S> {
        Span::new(self.0.saturating_sub(from.0))
    }
}

/// A place and a distance make a place.
impl<S> std::ops::Add<Span<S>> for Place<S> {
    type Output = Place<S>;
    fn add(self, by: Span<S>) -> Place<S> {
        Place::new(self.0 + by.0)
    }
}

impl<S> std::ops::Sub<Span<S>> for Place<S> {
    type Output = Place<S>;
    fn sub(self, by: Span<S>) -> Place<S> {
        Place::new(self.0.saturating_sub(by.0))
    }
}

impl<S> std::ops::Add for Span<S> {
    type Output = Span<S>;
    fn add(self, and: Span<S>) -> Span<S> {
        Span::new(self.0 + and.0)
    }
}

impl<S> std::ops::Sub for Span<S> {
    type Output = Span<S>;
    fn sub(self, less: Span<S>) -> Span<S> {
        Span::new(self.0.saturating_sub(less.0))
    }
}

impl<S> std::ops::Mul<usize> for Span<S> {
    type Output = Span<S>;
    fn mul(self, by: usize) -> Span<S> {
        Span::new(self.0 * by)
    }
}

impl<S> std::ops::Div<usize> for Span<S> {
    type Output = Span<S>;
    fn div(self, by: usize) -> Span<S> {
        Span::new(self.0 / by)
    }
}

/// A position in the units of `S` that need not fall on a pixel: a vertex of a seam, a corner of a
/// loop the reader drew.
///
/// Beside [`Place`] for [`Extent`]'s reason beside [`Span`]: a loop's vertex lies between pixels, and
/// rounding it to one moves the loop by up to half of one - which on a plane a quarter the size of
/// the photograph is two of the photograph's own.
pub struct Coordinate<S>(f64, PhantomData<fn() -> S>);

impl<S: Absolute> Coordinate<S> {
    pub const fn exactly(value: f64) -> Self {
        Coordinate(value, PhantomData)
    }
}

impl<S> Coordinate<S> {
    /// A frame that exists, measured. See [`Span::measured`].
    pub const fn measured(value: f64) -> Self {
        Coordinate(value, PhantomData)
    }

    /// The number again, for a uniform, an FFI or an index. Greppable, as [`Span::raw`] is.
    pub const fn raw(self) -> f64 {
        self.0
    }

    /// The same place on another picture of the same scene: as far along `to` as it is along
    /// `from`.
    ///
    /// **The one way a position crosses between spaces**, and so the one place the mapping lives -
    /// a caller holding a position in one picture and the extent of another cannot reach the
    /// other's pixels except through here, with both extents named.
    pub fn onto<T>(self, from: Span<S>, to: Span<T>) -> Coordinate<T> {
        let whole = from.0 as f64;
        Coordinate(
            match whole > 0.0 {
                true => self.0 / whole * to.0 as f64,
                false => 0.0,
            },
            PhantomData,
        )
    }
}

impl<S> Clone for Coordinate<S> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<S> Copy for Coordinate<S> {}
impl<S> PartialEq for Coordinate<S> {
    fn eq(&self, other: &Self) -> bool {
        self.0 == other.0
    }
}
impl<S> PartialOrd for Coordinate<S> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.0.partial_cmp(&other.0)
    }
}
impl<S> std::fmt::Debug for Coordinate<S> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(out, "{}", self.0)
    }
}

/// Two coordinates make a distance, and it may be either way: a loop's vertices are not ordered.
impl<S> std::ops::Sub for Coordinate<S> {
    type Output = Extent<S>;
    fn sub(self, from: Coordinate<S>) -> Extent<S> {
        Extent(self.0 - from.0, PhantomData)
    }
}

/// A coordinate and a distance make a coordinate.
impl<S> std::ops::Add<Extent<S>> for Coordinate<S> {
    type Output = Coordinate<S>;
    fn add(self, by: Extent<S>) -> Coordinate<S> {
        Coordinate(self.0 + by.0, PhantomData)
    }
}

/// Where a point lies on a picture, to a fraction of a pixel.
pub struct Point<S> {
    pub x: Coordinate<S>,
    pub y: Coordinate<S>,
}

impl<S> Point<S> {
    /// This point on another picture of the same scene. See [`Coordinate::onto`].
    pub fn onto<T>(self, from: Size<S>, to: Size<T>) -> Point<T> {
        Point {
            x: self.x.onto(from.width, to.width),
            y: self.y.onto(from.height, to.height),
        }
    }
}

impl<S> Clone for Point<S> {
    fn clone(&self) -> Self {
        *self
    }
}
impl<S> Copy for Point<S> {}
impl<S> PartialEq for Point<S> {
    fn eq(&self, other: &Self) -> bool {
        self.x == other.x && self.y == other.y
    }
}
impl<S> std::fmt::Debug for Point<S> {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("Point")
            .field("x", &self.x)
            .field("y", &self.y)
            .finish()
    }
}

/// A width and a height in the same space.
pub struct Size<S> {
    pub width: Span<S>,
    pub height: Span<S>,
}

/// A left and a top in the same space.
pub struct At<S> {
    pub x: Place<S>,
    pub y: Place<S>,
}

/// A rectangle: where it starts and how far it goes.
pub struct Rect<S> {
    pub at: At<S>,
    pub size: Size<S>,
}

// The same reason as `plain`: `derive` would bound these on `S`, which is uninhabited.
macro_rules! plain_shape {
    ($name:ident { $($field:ident),+ }) => {
        impl<S> Clone for $name<S> {
            fn clone(&self) -> Self {
                *self
            }
        }
        impl<S> Copy for $name<S> {}
        impl<S> PartialEq for $name<S> {
            fn eq(&self, other: &Self) -> bool {
                $(self.$field == other.$field &&)+ true
            }
        }
        impl<S> Eq for $name<S> {}
        impl<S> Default for $name<S> {
            fn default() -> Self {
                $name { $($field: Default::default()),+ }
            }
        }
        impl<S> std::fmt::Debug for $name<S> {
            fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                out.debug_struct(stringify!($name))
                    $(.field(stringify!($field), &self.$field))+
                    .finish()
            }
        }
    };
}
plain_shape!(Size { width, height });
plain_shape!(At { x, y });
plain_shape!(Rect { at, size });

impl<S: Absolute> Size<S> {
    pub const fn exact(width: usize, height: usize) -> Size<S> {
        Size {
            width: Span::new(width),
            height: Span::new(height),
        }
    }
}

impl<S> Size<S> {
    /// A size out of two distances already in this space, which is how a frame that has no
    /// constants gets one: from its own extent.
    pub const fn of(width: Span<S>, height: Span<S>) -> Size<S> {
        Size { width, height }
    }

    /// A frame that exists, measured. See [`Span::measured`].
    pub const fn measured(width: usize, height: usize) -> Size<S> {
        Size {
            width: Span::measured(width),
            height: Span::measured(height),
        }
    }

    const fn new(width: usize, height: usize) -> Size<S> {
        Size {
            width: Span::new(width),
            height: Span::new(height),
        }
    }

    /// The long edge, which is what a scale and a rendition's size are named against.
    pub fn long(self) -> Span<S> {
        self.width.max(self.height)
    }

    pub fn area(self) -> usize {
        self.width.raw() * self.height.raw()
    }

    pub fn raw(self) -> (usize, usize) {
        (self.width.raw(), self.height.raw())
    }

    /// This picture's extent on the [`Stored`] grid: [`STORED_LONG`] across its long edge and the
    /// short edge in proportion, which is what a stored position is mapped back out of.
    pub fn stored(self) -> Size<Stored> {
        let long = self.long().raw().max(1) as f64;
        let steps =
            |edge: Span<S>| (edge.raw() as f64 / long * STORED_LONG as f64).round() as usize;
        Size::new(steps(self.width), steps(self.height))
    }
}

impl<S: Absolute> At<S> {
    pub const fn exact(x: usize, y: usize) -> At<S> {
        At {
            x: Place::new(x),
            y: Place::new(y),
        }
    }
}

impl<S> At<S> {
    const fn new(x: usize, y: usize) -> At<S> {
        At {
            x: Place::new(x),
            y: Place::new(y),
        }
    }

    pub const ORIGIN: At<S> = At {
        x: Place::ORIGIN,
        y: Place::ORIGIN,
    };

    pub fn raw(self) -> (usize, usize) {
        (self.x.raw(), self.y.raw())
    }
}

impl<S: Absolute> Rect<S> {
    pub const fn exact(left: usize, top: usize, width: usize, height: usize) -> Rect<S> {
        Rect {
            at: At::new(left, top),
            size: Size::new(width, height),
        }
    }
}

impl<S> Rect<S> {
    /// The far edge on each axis, which is a place rather than a distance.
    pub fn past(self) -> At<S> {
        At {
            x: self.at.x + self.size.width,
            y: self.at.y + self.size.height,
        }
    }

    pub fn raw(self) -> (usize, usize, usize, usize) {
        (
            self.at.x.raw(),
            self.at.y.raw(),
            self.size.width.raw(),
            self.size.height.raw(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{
        At, Coordinate, Drawn, Extent, Photograph, Place, Point, Rect, STORED_LONG, Shrunk, Size,
        Span,
    };

    /// A point is the same place on every picture of the scene: a quarter of the way across the
    /// photograph is a quarter of the way across a plane a quarter its size, fraction and all.
    #[test]
    fn a_point_lands_at_the_same_place_on_a_picture_of_another_size() {
        let photograph = Size::<Photograph>::exact(6000, 4000);
        let shrunk = Size::<Shrunk>::exact(375, 250);
        let at = Point {
            x: Coordinate::<Photograph>::exactly(1500.0),
            y: Coordinate::exactly(1001.5),
        };

        let there = at.onto(photograph, shrunk);
        assert_eq!(there.x.raw(), 93.75);
        assert_eq!(there.y.raw(), 62.59375);
        assert_eq!(there.onto(shrunk, photograph), at, "and back, exactly");

        // A frame with no extent sends every point to its origin rather than to infinity.
        let empty = Size::<Shrunk>::exact(0, 0);
        assert_eq!(
            Point {
                x: Coordinate::exactly(3.0),
                y: Coordinate::exactly(4.0)
            }
            .onto(empty, shrunk)
            .x
            .raw(),
            0.0
        );
    }

    /// A stored position comes back where it was written, on a photograph of any shape, and the grid
    /// is square: a step across is the same length as a step down.
    #[test]
    fn a_stored_position_is_the_same_place_and_the_grid_is_square() {
        let photograph = Size::<Photograph>::exact(6000, 4000);
        let stored = photograph.stored();
        assert_eq!(stored.raw(), (STORED_LONG, 43690));

        let at = Point {
            x: Coordinate::<Photograph>::exactly(1234.5),
            y: Coordinate::exactly(3456.25),
        };
        let written = at.onto(photograph, stored);
        let read = written.onto(stored, photograph);
        assert!((read.x.raw() - 1234.5).abs() < 1e-9 && (read.y.raw() - 3456.25).abs() < 1e-9);

        let across = STORED_LONG as f64 / 6000.0;
        let down = stored.height.raw() as f64 / 4000.0;
        assert!(
            (across - down).abs() / across < 1e-4,
            "{across} steps a pixel across, {down} down"
        );

        // Portrait too: the long edge is the height, and it is the height that spans the grid.
        assert_eq!(
            Size::<Photograph>::exact(4000, 6000).stored().raw(),
            (43690, STORED_LONG)
        );
    }

    /// A distance crosses as a position does, and a negative one stays negative: a fill read from
    /// the left of where it lands is written as an offset leftward.
    #[test]
    fn a_distance_is_the_same_share_of_another_picture() {
        let photograph = Size::<Photograph>::exact(6000, 4000);
        let stored = photograph.stored();
        let leftward = Extent::<Photograph>::exactly(-600.0).onto(photograph.width, stored.width);
        assert!((leftward.raw() + 6553.5).abs() < 1e-9, "{leftward:?}");
        let back = leftward.onto(stored.width, photograph.width);
        assert!((back.raw() + 600.0).abs() < 1e-9, "{back:?}");
    }

    /// Two coordinates are a distance either way round, and a distance moves one to the other.
    #[test]
    fn coordinates_and_extents_compose_the_way_a_loop_does() {
        let (a, b) = (
            Coordinate::<Photograph>::exactly(10.25),
            Coordinate::exactly(4.0),
        );
        assert_eq!((a - b).raw(), 6.25);
        assert_eq!((b - a).raw(), -6.25);
        assert_eq!(b + Extent::exactly(6.25), a);
    }

    /// The affine algebra, which is the half of this that a space marker cannot catch.
    ///
    /// Two edges make a width; an edge and a width make the far edge. Both were `usize + usize`
    /// before, and the compiler had nothing to say about which was which.
    #[test]
    fn places_and_spans_compose_the_way_a_rectangle_does() {
        let left: Place<Photograph> = Place::new(100);
        let width: Span<Photograph> = Span::new(40);

        assert_eq!(
            left + width,
            Place::new(140),
            "an edge and a width are the far edge"
        );
        assert_eq!(
            Place::<Photograph>::new(140) - left,
            width,
            "two edges are a width"
        );
        assert_eq!(width + width, Span::new(80), "two widths are a width");

        // Saturating, as the arithmetic it replaces was: a window clamped to the frame's own edge
        // subtracts past zero at the origin, and did so as `usize` without complaint.
        assert_eq!(left - Span::new(400), Place::new(0));
        assert_eq!(Place::<Photograph>::new(10) - Place::new(90), Span::new(0));
    }

    /// A rectangle's far edge is a place, not a size, and `past` is the only way to it.
    #[test]
    fn a_rectangle_knows_where_it_stops() {
        let rect: Rect<Drawn> = Rect::exact(30, 40, 10, 20);
        assert_eq!(rect.past(), At::new(40, 60));
        assert_eq!(rect.raw(), (30, 40, 10, 20));
    }

    /// Flooring to a step is what a window's origin does to land on a whole texel.
    #[test]
    fn flooring_lands_on_the_step_below() {
        let step: Span<Photograph> = Span::new(16);
        assert_eq!(Place::<Photograph>::new(100).floor_to(step), Place::new(96));
        assert_eq!(Place::<Photograph>::new(96).floor_to(step), Place::new(96));
        // A step of zero is no grid at all rather than a division by it.
        assert_eq!(
            Place::<Photograph>::new(100).floor_to(Span::new(0)),
            Place::new(100)
        );
    }

    /// The long edge is what a scale and a rendition's size are both named against.
    #[test]
    fn a_size_reports_its_long_edge_and_its_area() {
        let size: Size<Photograph> = Size::new(4000, 6000);
        assert_eq!(size.long(), Span::new(6000));
        assert_eq!(size.area(), 24_000_000);
    }

    /// **The whole point, and it cannot be written as a test.**
    ///
    /// Every line below is a compile error, which is why they are in a comment rather than in the
    /// body: there is no way to assert that something does not build from inside the thing that
    /// would not build. `trybuild` would say it, at the cost of a dependency and a second corpus of
    /// fixture files for a rule the type system already refuses to break.
    ///
    /// ```ignore
    /// let photo: Place<Photograph> = Place::new(10);
    /// let drawn: Place<Drawn> = Place::new(10);
    /// let _ = photo - drawn;              // two spaces
    /// let _: Place<Drawn> = photo;        // two spaces
    /// let _ = photo + Place::new(4);      // two places
    /// let width: Span<Photograph> = Span::new(4);
    /// let _: Span<Drawn> = width;         // two spaces
    /// let _: Place<Photograph> = width;   // a distance where a position goes
    /// let vertex: Coordinate<Photograph> = Coordinate::exactly(1.5);
    /// let _: Coordinate<Drawn> = vertex;  // two spaces
    /// let _ = vertex + vertex;            // two positions
    /// let _: Point<Drawn> = Point { x: vertex, y: vertex };  // two spaces
    /// ```
    #[test]
    fn the_spaces_do_not_mix() {
        // What the doc above cannot: that the two are distinct types holding the same number, so
        // nothing about the representation is what keeps them apart.
        let photo: Place<Photograph> = Place::new(10);
        let drawn: Place<Drawn> = Place::new(10);
        assert_eq!(photo.raw(), drawn.raw());
        assert_eq!(
            std::mem::size_of::<Place<Photograph>>(),
            std::mem::size_of::<usize>()
        );
        assert_eq!(
            std::mem::size_of::<Rect<Drawn>>(),
            std::mem::size_of::<[usize; 4]>()
        );
        assert_eq!(
            std::mem::size_of::<Point<Photograph>>(),
            std::mem::size_of::<[f64; 2]>()
        );
    }

    /// The failure this module opens on, in the shape §3.1 met it: **the same count of pixels is a
    /// different distance on a different plane.**
    ///
    /// `composite_align::Kind` searches a burst at 808 where a pan wants 1616, and the corner check
    /// reads its number in those pixels while its bound is in the analysis plane's. Resolved as a
    /// share, one reading crosses and the other does not, which is the answer; taken as a bare
    /// count, both pass and one of them should not.
    #[test]
    fn a_share_carries_a_search_plane_reading_onto_the_analysis_plane() {
        let analysis = Span::<super::Analysis>::exact(3000);
        let bound = super::Extent::<super::Analysis>::exactly(1.15);

        // One radial reading, the same frames, measured on each of the two planes: the number
        // halves with the plane, being a count of its pixels.
        let wide = super::Share::measured(0.6, 1616.0).across(analysis);
        let narrow = super::Share::measured(0.3, 808.0).across(analysis);
        assert!(
            (wide.raw() - narrow.raw()).abs() < 1e-9,
            "one displacement, two planes"
        );
        assert!(wide < bound, "1.11 analysis px is inside the budget");

        // And what the bare count would have done with the second of those: 0.6 on an 808px plane
        // is twice the displacement of 0.6 on a 1616px one, and over.
        let doubled = super::Share::measured(0.6, 808.0).across(analysis);
        assert!(
            doubled > bound,
            "2.23 analysis px is the whole of §3.3's budget, not half"
        );
    }

    /// `over` sizes something and `across` compares with something, which is why they round
    /// differently: a footprint of no pixels is not one, and a bound of one pixel is not zero.
    #[test]
    fn a_share_being_compared_is_not_rounded_up_to_a_pixel() {
        let long = Span::<Photograph>::exact(1000);
        assert_eq!(
            super::Share::of(1, 10_000).over(long).raw(),
            1,
            "sized, and never to nothing"
        );
        assert!(
            super::Share::of(1, 10_000).across(long).raw() < 0.11,
            "compared, and exact"
        );
    }
}
