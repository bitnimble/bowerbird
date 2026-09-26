//! What a render is looking at: which rectangle of a photograph, at what resolution.
//!
//! **Every coordinate here is the photograph's own, at the sensor's resolution.** That is the whole
//! discipline: a stage that needs buffer indices converts at the point it indexes, through
//! [`Scale`], and never earlier. Coordinates that have already been scaled somewhere upstream are
//! how a window ends up correct at one resolution and half a pixel out at another - and the second
//! is not a failure, it is a slightly different photograph.
//!
//! One type because the callers are the same call at different settings: a loupe tile is a small
//! window at full scale, a max-quality rendition is the whole picture at full scale, a 4K rendition
//! of a 61MP frame is the whole picture at half, and a cropped render of either is the rectangle
//! its geometry reads.

/// How much of the sensor's resolution a render asks for.
///
/// **Two, and not a ratio, because the decode offers two.** Halving is not a resize: it reads one
/// RGB pixel straight off each 2x2 CFA site - red from the red photosite, blue from the blue, the
/// two greens averaged - and skips the demosaic entirely. There is nothing to interpolate at one
/// pixel per site, every colour there having actually been measured. Any other size is a resize of
/// one of these two, which happens further down and is a different question.
/// Crosses the API as `"full"` or `"half"`, and defaults to `full`: a client that says nothing
/// gets every photosite, which is what a loupe wants and the safe answer for anything else.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scale {
    /// Every photosite, through RCD.
    #[default]
    Full,
    /// One pixel per CFA site, no demosaic.
    Half,
}

impl Scale {
    /// Whether the decode should take the halving fork.
    pub fn halves(self) -> bool {
        self == Scale::Half
    }

    /// What a length of the photograph measures at this scale.
    pub fn of(self, length: usize) -> usize {
        match self {
            Scale::Full => length,
            Scale::Half => length / 2,
        }
    }

    /// A distance of the photograph, in the pixels the decode produces.
    ///
    /// **The only way across, and there are three of them because rounding is not one rule.** A
    /// distance and a near edge floor; a far edge rounds out, so that a rectangle at an odd
    /// coordinate still covers what was asked for rather than dropping a pixel at the seam between
    /// two tiles. Choosing between them is the caller's, which is why they are named rather than
    /// folded into one `of`.
    pub fn span(self, of: crate::px::Span<crate::px::Photograph>) -> crate::px::Span<crate::px::Drawn> {
        // **A distance that is not zero does not become zero.** Halving one pixel floors to none,
        // and a window that had a pixel in it and now has none is an empty crop: a panorama whose
        // source clips the window by a single column hands that crop to a region decode, and
        // `Placement::oriented_rect` computes `frame_w - 1` on it and underflows.
        crate::px::Span::exact(match of.raw() {
            0 => 0,
            raw => self.of(raw).max(1),
        })
    }

    /// A near edge of the photograph, in the pixels the decode produces.
    pub fn at(self, place: crate::px::Place<crate::px::Photograph>) -> crate::px::Place<crate::px::Drawn> {
        crate::px::Place::exact(self.of(place.raw()))
    }

    /// A far edge, rounded out so the rectangle it closes covers every pixel asked for.
    pub fn past(self, place: crate::px::Place<crate::px::Photograph>) -> crate::px::Place<crate::px::Drawn> {
        match self {
            Scale::Full => crate::px::Place::exact(place.raw()),
            Scale::Half => crate::px::Place::exact(place.raw().div_ceil(2)),
        }
    }

    /// Back the other way, for the one rectangle named in the sensor's terms: what to read.
    ///
    /// A drawn coordinate multiplied up lands on a whole CFA site by construction, which is what a
    /// halved decode requires of its region and what scaling a photograph coordinate down could not
    /// promise.
    pub fn read_at(self, place: crate::px::Place<crate::px::Drawn>) -> crate::px::Place<crate::px::Photograph> {
        match self {
            Scale::Full => crate::px::Place::exact(place.raw()),
            Scale::Half => crate::px::Place::exact(place.raw() * 2),
        }
    }

    /// The same, for a distance.
    pub fn read_span(self, span: crate::px::Span<crate::px::Drawn>) -> crate::px::Span<crate::px::Photograph> {
        match self {
            Scale::Full => crate::px::Span::exact(span.raw()),
            Scale::Half => crate::px::Span::exact(span.raw() * 2),
        }
    }

    /// The whole photograph as a decode that is resized before it is corrected produces it.
    pub fn decoded(self, photograph: crate::px::Size<crate::px::Photograph>) -> crate::px::Size<crate::px::Decoded> {
        let (width, height) = (self.span(photograph.width), self.span(photograph.height));
        crate::px::Size::exact(width.raw(), height.raw())
    }

    /// [`Scale::read_at`], for a region of that decode.
    pub fn read_decoded(self, place: crate::px::Place<crate::px::Decoded>) -> crate::px::Place<crate::px::Photograph> {
        self.read_at(crate::px::Place::exact(place.raw()))
    }

    /// [`Scale::read_span`], for a region of that decode.
    pub fn read_decoded_span(self, span: crate::px::Span<crate::px::Decoded>) -> crate::px::Span<crate::px::Photograph> {
        self.read_span(crate::px::Span::exact(span.raw()))
    }

    /// The scale worth taking to render `photograph` no larger than `long_edge` on its long side.
    ///
    /// **Asked of the photograph, never of a window.** Whether a 61MP sensor is worth halving for a
    /// 4K rendition is a question about the picture; a rectangle of it asked the same question of
    /// its own dimensions would answer differently for every tile, and then two pieces of one
    /// render would be demosaiced differently.
    ///
    /// `0` is the sensor's own size, which is what a loupe and a max-quality rendition ask for.
    pub fn for_long_edge(photograph: (usize, usize), long_edge: u32) -> Scale {
        let long = photograph.0.max(photograph.1) as u32;
        match long_edge > 0 && long / 2 >= long_edge {
            true => Scale::Half,
            false => Scale::Full,
        }
    }
}

/// The rectangle of a photograph a render is producing, and at what resolution.
///
/// **The one place the two spaces are allowed to meet.** Its fields are the photograph's, because
/// that is what a caller names; everything it answers is the buffer's, because that is what the
/// decode hands back. A reader that wants the second asks this rather than dividing.
#[derive(Clone, Copy)]
pub struct View {
    /// The whole picture, at the sensor's resolution.
    pub photograph: crate::px::Size<crate::px::Photograph>,
    /// What is wanted of it, in the photograph's own pixels.
    pub window: crate::px::Rect<crate::px::Photograph>,
    pub scale: Scale,
}

impl View {
    /// The whole photograph, at the sensor's resolution.
    pub fn whole(photograph: crate::px::Size<crate::px::Photograph>) -> View {
        View {
            photograph,
            window: crate::px::Rect { at: crate::px::At::ORIGIN, size: photograph },
            scale: Scale::Full,
        }
    }

    /// The same view of the same rectangle, at the resolution this render wants.
    pub fn at(self, scale: Scale) -> View {
        View { scale, ..self }
    }

    /// The same photograph, showing `window` of it.
    pub fn showing(self, window: crate::px::Rect<crate::px::Photograph>) -> View {
        View { window, ..self }
    }

    /// Whether this is the whole picture rather than a piece of one.
    pub fn is_whole(&self) -> bool {
        self.window.at == crate::px::At::ORIGIN && self.window.size == self.photograph
    }

    /// The buffer this view produces, in its own pixels.
    pub fn size(&self) -> crate::px::Size<crate::px::Drawn> {
        crate::px::Size {
            width: self.scale.span(self.window.size.width),
            height: self.scale.span(self.window.size.height),
        }
    }

    /// The photograph as this view draws it, which is what a geometry's fractions are of.
    pub fn drawn(&self) -> crate::px::Size<crate::px::Drawn> {
        crate::px::Size {
            width: self.scale.span(self.photograph.width),
            height: self.scale.span(self.photograph.height),
        }
    }

    /// Where the window starts, in the buffer's own pixels.
    pub fn origin(&self) -> crate::px::At<crate::px::Drawn> {
        crate::px::At { x: self.scale.at(self.window.at.x), y: self.scale.at(self.window.at.y) }
    }
}

#[cfg(test)]
mod tests {
    use super::{Scale, View};

    /// The one decision the scale makes, and it is the photograph's rather than a window's.
    #[test]
    fn the_scale_is_asked_of_the_photograph() {
        let photograph = (6000, 4000);
        assert_eq!(Scale::for_long_edge(photograph, 0), Scale::Full);
        assert_eq!(Scale::for_long_edge(photograph, 1600), Scale::Half);
        // A target more than half the sensor's long edge has nothing to halve into.
        assert_eq!(Scale::for_long_edge(photograph, 3500), Scale::Full);
        assert_eq!(Scale::for_long_edge(photograph, 3000), Scale::Half);

        // **A window would answer differently, which is the mistake this exists to prevent.** The
        // same render, asked of a 512px loupe rectangle, would never halve - so two pieces of one
        // picture would be demosaiced two ways.
        assert_eq!(Scale::for_long_edge((512, 512), 1600), Scale::Full);
    }

    #[test]
    fn a_window_keeps_the_photographs_coordinates_and_converts_once() {
        let photograph = crate::px::Size::exact(6000, 4000);
        let view = View::whole(photograph)
            .showing(crate::px::Rect::exact(1000, 800, 2000, 1600))
            .at(Scale::Half);
        // The window is still named where it is in the photograph...
        assert_eq!(view.window.raw(), (1000, 800, 2000, 1600));
        // ...and everything the buffer needs comes off it at the point of use. The types say which
        // is which: `window` is `Photograph` and none of the three below can be assigned to it.
        assert_eq!(view.size().raw(), (1000, 800));
        assert_eq!(view.origin().raw(), (500, 400));
        assert_eq!(view.drawn().raw(), (3000, 2000));
        assert!(!view.is_whole());

        let whole = View::whole(photograph);
        assert!(whole.is_whole());
        assert_eq!(whole.size().raw(), (6000, 4000));
        assert_eq!(whole.origin().raw(), (0, 0));
    }

    /// A far edge rounds out where a near edge floors, so a rectangle at an odd coordinate still
    /// covers what was asked for.
    ///
    /// **The pixel at the seam.** Two tiles meeting at an odd column each halve it; flooring both
    /// leaves that column in neither, and the picture has a line through it that no test of one
    /// tile can see.
    #[test]
    fn a_far_edge_rounds_out_and_a_near_edge_floors() {
        let near: crate::px::Place<crate::px::Photograph> = crate::px::Place::exact(101);
        assert_eq!(Scale::Half.at(near).raw(), 50);
        assert_eq!(Scale::Half.past(near).raw(), 51);
        assert_eq!(Scale::Full.at(near).raw(), 101);
        assert_eq!(Scale::Full.past(near).raw(), 101);

        // And back up lands on a whole CFA site, which is what a halved decode needs of its region.
        assert_eq!(Scale::Half.read_at(crate::px::Place::exact(50)).raw(), 100);
        assert_eq!(Scale::Half.read_span(crate::px::Span::exact(50)).raw(), 100);
    }
}
