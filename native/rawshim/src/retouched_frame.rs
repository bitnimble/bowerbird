//! A frame with its repairs drawn, and the original under each.
//!
//! **An original is derived from the frame, and nothing can change the frame without deriving it
//! again.** A [`RetouchedFrame`] owns its buffer and never hands it out: it is written by
//! [`RetouchedFrame::drawn`], [`RetouchedFrame::redraw`] and [`RetouchedFrame::write_rows`] alone,
//! and all three run the repair pass, which cuts each repair's footprint out of the frame before
//! painting over it. So a band of a
//! re-prepare, a whole prepare and a frame assembled from tiles all leave the originals describing
//! the pixels that are there - there is no write to forget to follow. Everything that reads the
//! frame reads it through a method here.
//!
//! Held in memory for the life of an open and nowhere else: an original is what the tool shows as
//! a removal's thumbnail and what a removal reopened is searched over, and both are the editor's.

use crate::px::{At, Drawn, Extent, Point, Rect, Size, Stored};
use crate::repair::Repair;
use crate::resident::Resident;

/// The pixels under one repair's footprint - its seam and the feather outside it - before any
/// repair was drawn over them.
struct Original {
    repair: Repair,
    /// Where, in the whole picture's pixels, clamped to the frame it was cut from.
    rect: Rect<Drawn>,
    rgb: Resident,
}

/// A frame with its repairs drawn, and the original under each.
pub struct RetouchedFrame {
    frame: Resident,
    /// The picture this frame is a window of, and where it sits in it.
    whole: Size<Drawn>,
    origin: At<Drawn>,
    /// The repairs the frame was last drawn with, which is the set an original has to belong to.
    repairs: Vec<Repair>,
    originals: Vec<Original>,
}

impl RetouchedFrame {
    /// `frame`, a window at `origin` of a picture of `whole`'s size, with `repairs` drawn over it.
    pub fn drawn(
        frame: Resident,
        whole: Size<Drawn>,
        origin: At<Drawn>,
        repairs: &[Repair],
    ) -> Result<RetouchedFrame, String> {
        let mut drawn = RetouchedFrame {
            frame,
            whole,
            origin,
            repairs: Vec::new(),
            originals: Vec::new(),
        };
        drawn.draw(repairs)?;
        Ok(drawn)
    }

    /// The frame drawn with `repairs` instead of the ones it holds, off the originals rather than
    /// a new prepare.
    pub fn redraw(&mut self, repairs: &[Repair]) -> Result<(), String> {
        let gpu = self.frame.gpu();
        let (fx, fy) = self.origin.raw();
        let mut recording = gpu.record();
        // Every original is what was there before any repair, so where two overlap they agree.
        for original in &self.originals {
            let (x, y, wide, deep) = original.rect.raw();
            copy(
                &mut recording,
                (&original.rgb, At::ORIGIN),
                (&self.frame, At::exact(x - fx, y - fy)),
                Size::exact(wide, deep),
            );
        }
        recording.submit();
        self.draw(repairs)
    }

    fn draw(&mut self, repairs: &[Repair]) -> Result<(), String> {
        let cuts = crate::repair::apply(&self.frame, self.whole, self.origin, repairs)?;
        let (left, top) = self.origin.raw();
        self.originals = cuts
            .into_iter()
            .map(|cut| {
                let (x, y, wide, deep) = cut.rect.raw();
                Original {
                    repair: repairs[cut.repair].clone(),
                    rect: Rect::exact(left + x, top + y, wide, deep),
                    rgb: cut.rgb,
                }
            })
            .collect();
        self.repairs = repairs.to_vec();
        Ok(())
    }

    /// The frame alone, for a caller that keeps no originals: a loupe tile, a rendition.
    pub fn into_frame(self) -> Resident {
        self.frame
    }

    pub fn size(&self) -> (usize, usize) {
        self.frame.size()
    }

    /// `rows` rows of `band`, from its row `from`, written over this frame's rows from `to`, and
    /// the originals under them with them.
    ///
    /// **Row for row, what the frame takes the originals take.** A sweep that stops part-way leaves
    /// some rows at one setting and some at another, and the originals say the same. A repair the
    /// band was not drawn with is one the document no longer holds, so its original goes.
    pub fn write_rows(
        &mut self,
        band: RetouchedFrame,
        from: usize,
        rows: usize,
        to: usize,
    ) -> Result<(), String> {
        let (width, height) = self.frame.size();
        let band_width = band.frame.size().0;
        if band_width != width {
            return Err(format!(
                "a band {band_width} wide cannot be written into a frame {width} wide"
            ));
        }
        let gpu = self.frame.gpu();
        let bytes = |samples: usize| (samples * 2) as u64;
        let row = width * 3;
        // The last band of an odd-height, odd-width frame is an odd number of samples, which is
        // half a word short of a copy. Rounded up rather than refused, and only for the band that
        // reaches the frame's last row: both buffers are allocated to whole words
        // (`Resident::empty`), and this band ends at the last sample of each, so the extra half is
        // that padding at both ends rather than a neighbouring pixel.
        let size = match to + rows == height {
            true => bytes(rows * row).next_multiple_of(4),
            false => bytes(rows * row),
        };
        let mut recording = gpu.record();
        recording.encoder().copy_buffer_to_buffer(
            band.frame.buffer(),
            bytes(from * row),
            self.frame.buffer(),
            bytes(to * row),
            size,
        );

        self.originals
            .retain(|original| band.repairs.contains(&original.repair));
        self.repairs = band.repairs.clone();
        let written = self.origin.raw().1 + to..self.origin.raw().1 + to + rows;
        for piece in &band.originals {
            let (x, y, wide, deep) = piece.rect.raw();
            let (first, past) = (y.max(written.start), (y + deep).min(written.end));
            if first >= past {
                continue;
            }
            let at = match self.originals.iter().position(|o| o.repair == piece.repair) {
                Some(at) => at,
                None => {
                    let rect = self.footprint(&piece.repair);
                    let (_, _, wide, deep) = rect.raw();
                    self.originals.push(Original {
                        repair: piece.repair.clone(),
                        rect,
                        rgb: Resident::empty(gpu, wide, deep),
                    });
                    self.originals.len() - 1
                }
            };
            let original = &self.originals[at];
            let (ox, oy, _, _) = original.rect.raw();
            copy(
                &mut recording,
                (&piece.rgb, At::exact(0, first - y)),
                (&original.rgb, At::exact(x - ox, first - oy)),
                Size::exact(wide, past - first),
            );
        }
        recording.submit();
        band.frame.reclaim();
        Ok(())
    }

    /// The frame's resources for a grade, as `gpu::Gpu::upload_resident` builds them.
    pub fn upload(
        &self,
        grade: &crate::gpu::Grade<'_>,
        peak: &crate::gpu::ScenePeak,
    ) -> crate::gpu::Uploaded<'static> {
        self.frame.gpu().upload_resident(&self.frame, grade, peak)
    }

    pub fn pyramid(&self, base: &'static crate::base::Base) -> Option<crate::base::Pyramid> {
        crate::base::pyramid_of(self.frame.gpu(), base, &self.frame, self.frame.size())
    }

    /// The search around `drawn` started over this frame - or, `without` a repair it holds, over
    /// the picture with that one's original put back and every other repair still drawn. `donor`
    /// is where the reader put the fill, which is then placed there rather than searched for.
    pub fn measure(
        &self,
        drawn: Vec<Point<Stored>>,
        without: Option<&Repair>,
        donor: Option<[Extent<Stored>; 2]>,
    ) -> Result<crate::repair_solve::Measuring, String> {
        let Some(repair) = without else {
            return crate::repair_solve::measure(
                &self.frame,
                self.whole,
                self.origin,
                drawn,
                donor,
            );
        };
        let searched = crate::repair_solve::searched(self.whole, &drawn, donor);
        let (window, at) = self.original_under(repair, searched)?;
        crate::repair_solve::measure(&window, self.whole, at, drawn, donor)
    }

    /// `rect` of the picture, as far as this frame holds it, with `repair`'s original put back:
    /// what is under it, among everything else as drawn. Answers the copy and where it sits in the
    /// picture.
    pub fn original_under(
        &self,
        repair: &Repair,
        rect: Rect<Drawn>,
    ) -> Result<(Resident, At<Drawn>), String> {
        self.window(Some(repair), rect)
    }

    /// `rect` of the picture with `option` drawn in place of `showing` - or over the frame as it is,
    /// where nothing is showing: what the frame would be with that fill chosen. The copy is grown to
    /// hold where `option` reads its fill from, and answered with where it sits in the picture.
    pub fn drawn_instead(
        &self,
        showing: Option<&Repair>,
        option: &Repair,
        rect: Rect<Drawn>,
    ) -> Result<(Resident, At<Drawn>), String> {
        let placed = option.on(self.whole);
        let (x, y, wide, deep) = rect.raw();
        let [lands, reads] = [placed.lands(), placed.reads()];
        let [left, top] = [0, 1].map(|at| lands[at].min(reads[at]).max(0) as usize);
        let [right, bottom] = [2, 3].map(|at| lands[at].max(reads[at]).max(0) as usize);
        let (left, top) = (left.min(x), top.min(y));
        let (right, bottom) = (right.max(x + wide), bottom.max(y + deep));
        let (window, at) =
            self.window(showing, Rect::exact(left, top, right - left, bottom - top))?;
        crate::repair::apply(&window, self.whole, at, std::slice::from_ref(option))?;
        Ok((window, at))
    }

    /// `rect` of the picture, as far as this frame holds it, with `without`'s original put back.
    fn window(
        &self,
        without: Option<&Repair>,
        rect: Rect<Drawn>,
    ) -> Result<(Resident, At<Drawn>), String> {
        let original = without
            .map(|repair| {
                self.originals
                    .iter()
                    .find(|original| &original.repair == repair)
                    .ok_or("that repair is not drawn on this part of the picture")
            })
            .transpose()?;
        let held = self.held();
        let rect = intersection(rect, held).ok_or("that part of the picture is not held")?;
        let (x, y, wide, deep) = rect.raw();
        let (fx, fy) = self.origin.raw();
        let gpu = self.frame.gpu();
        let window = Resident::empty(gpu, wide, deep);
        let mut recording = gpu.record();
        copy(
            &mut recording,
            (&self.frame, At::exact(x - fx, y - fy)),
            (&window, At::ORIGIN),
            Size::exact(wide, deep),
        );
        if let Some((original, under)) =
            original.and_then(|original| Some((original, intersection(original.rect, rect)?)))
        {
            let (ux, uy, uw, ud) = under.raw();
            let (ox, oy, _, _) = original.rect.raw();
            copy(
                &mut recording,
                (&original.rgb, At::exact(ux - ox, uy - oy)),
                (&window, At::exact(ux - x, uy - y)),
                Size::exact(uw, ud),
            );
        }
        recording.submit();
        Ok((window, At::exact(x, y)))
    }

    /// The part of the picture this frame holds, in the picture's pixels.
    fn held(&self) -> Rect<Drawn> {
        let (x, y) = self.origin.raw();
        let (wide, deep) = self.frame.size();
        Rect::exact(x, y, wide, deep)
    }

    /// Where `repair` lands on this frame, in the picture's pixels: the rect its original covers.
    fn footprint(&self, repair: &Repair) -> Rect<Drawn> {
        let [left, top, right, bottom] = repair.on(self.whole).lands();
        let (wide, deep) = self.whole.raw();
        let clamp = |at: isize, most: usize| at.clamp(0, most as isize) as usize;
        let [left, right] = [left, right].map(|x| clamp(x, wide));
        let [top, bottom] = [top, bottom].map(|y| clamp(y, deep));
        let rect = Rect::exact(left, top, right - left, bottom - top);
        intersection(rect, self.held()).unwrap_or(Rect::exact(left, top, 0, 0))
    }
}

fn intersection(a: Rect<Drawn>, b: Rect<Drawn>) -> Option<Rect<Drawn>> {
    let (ax, ay, aw, ad) = a.raw();
    let (bx, by, bw, bd) = b.raw();
    let (left, top) = (ax.max(bx), ay.max(by));
    let (right, bottom) = ((ax + aw).min(bx + bw), (ay + ad).min(by + bd));
    (left < right && top < bottom).then(|| Rect::exact(left, top, right - left, bottom - top))
}

/// `Params` in `copy_rect.slang`.
#[repr(C)]
#[derive(Clone, Copy, Default, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    src_width: u32,
    dst_width: u32,
    src_at: [u32; 2],
    dst_at: [u32; 2],
    size: [u32; 2],
    first_word: u32,
    words: u32,
    pad: [u32; 2],
}

/// The block's size, for `wgsl_layout.rs` to hold against the shader's own.
#[cfg(test)]
pub(crate) fn params_block() -> usize {
    std::mem::size_of::<Params>()
}

fn copying(gpu: &'static crate::gpu::Gpu) -> &'static crate::hdr_fit::Kernel {
    use crate::hdr_fit::{READ, UNIFORM, WRITE};
    static BUILT: std::sync::OnceLock<crate::hdr_fit::Kernel> = std::sync::OnceLock::new();
    BUILT.get_or_init(|| {
        crate::hdr_fit::kernel(
            gpu,
            "copy_rect",
            include_str!(concat!(env!("OUT_DIR"), "/wgsl/copy_rect.wgsl")),
            &[(0, UNIFORM), (1, READ), (2, WRITE)],
            &[],
        )
    })
}

/// A `size` rectangle of one frame at its `At` copied over another at its own, recorded.
pub(crate) fn copy(
    recording: &mut crate::gpu::Recording<'_>,
    (src, src_at): (&Resident, At<Drawn>),
    (dst, dst_at): (&Resident, At<Drawn>),
    size: Size<Drawn>,
) {
    let (wide, deep) = size.raw();
    if wide == 0 || deep == 0 {
        return;
    }
    let gpu = dst.gpu();
    let kernel = copying(gpu);
    let dst_width = dst.size().0;
    let (dx, dy) = dst_at.raw();
    let first = (dy * dst_width + dx) * 3;
    let last = ((dy + deep - 1) * dst_width + dx + wide - 1) * 3 + 2;
    let words = last / 2 - first / 2 + 1;
    let block = Params {
        src_width: src.size().0 as u32,
        dst_width: dst_width as u32,
        src_at: [src_at.raw().0 as u32, src_at.raw().1 as u32],
        dst_at: [dx as u32, dy as u32],
        size: [wide as u32, deep as u32],
        first_word: (first / 2) as u32,
        words: words as u32,
        ..Default::default()
    };
    recording.holding(src.buffer());
    recording.holding(dst.buffer());
    let uniform = recording.init(&wgpu::util::BufferInitDescriptor {
        label: Some("copy rect params"),
        contents: bytemuck::bytes_of(&block),
        usage: wgpu::BufferUsages::UNIFORM,
    });
    let group = gpu.bind_group(&wgpu::BindGroupDescriptor {
        label: Some("copy rect"),
        layout: &kernel.layout,
        entries: &[
            crate::repair::entry(0, &uniform),
            crate::repair::entry(1, src.buffer()),
            crate::repair::entry(2, dst.buffer()),
        ],
    });
    let (x, y) = crate::base::groups(words);
    let mut pass = recording.encoder().begin_compute_pass(&Default::default());
    pass.set_pipeline(&kernel.pipeline);
    pass.set_bind_group(0, &group, &[]);
    pass.dispatch_workgroups(x, y, 1);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repair::tests::{loop_around, striped_with_a_disc};

    // Odd both ways, so rows start mid-word.
    const SIZE: (usize, usize) = (201, 161);
    const CENTRE: (f64, f64) = (100.0, 80.0);

    fn whole() -> Size<Drawn> {
        Size::exact(SIZE.0, SIZE.1)
    }

    fn everything() -> Rect<Drawn> {
        Rect::exact(0, 0, SIZE.0, SIZE.1)
    }

    fn upload(samples: &[u16], rows: usize) -> Resident {
        Resident::upload(
            crate::gpu::device().expect("a device"),
            samples,
            SIZE.0,
            rows,
        )
    }

    fn host(frame: &Resident) -> Vec<u16> {
        pollster::block_on(frame.host()).expect("read back")
    }

    fn offered(frame: &RetouchedFrame, without: Option<&Repair>) -> Vec<Repair> {
        pollster::block_on(async {
            frame
                .measure(loop_around(whole(), CENTRE), without, None)?
                .solved(&[], true)
                .await
        })
        .expect("solved")
    }

    fn rows(samples: &[u16], top: usize, rows: usize) -> &[u16] {
        &samples[top * SIZE.0 * 3..(top + rows) * SIZE.0 * 3]
    }

    #[test]
    fn a_repair_taken_off_shows_the_picture_it_was_drawn_over() {
        let before = striped_with_a_disc(SIZE, CENTRE);
        let bare = RetouchedFrame::drawn(upload(&before, SIZE.1), whole(), At::ORIGIN, &[])
            .expect("drawn");
        let repair = offered(&bare, None).remove(0);
        let frame = RetouchedFrame::drawn(
            upload(&before, SIZE.1),
            whole(),
            At::ORIGIN,
            std::slice::from_ref(&repair),
        )
        .expect("drawn");
        assert_ne!(host(&frame.frame), before, "the repair drew nothing");

        let (under, at) = frame.original_under(&repair, everything()).expect("under");
        assert_eq!(at, At::ORIGIN);
        assert_eq!(host(&under), before);

        let (left, top, wide, deep) = (37, 51, 83, 57);
        let (under, at) = frame
            .original_under(&repair, Rect::exact(left, top, wide, deep))
            .expect("under");
        assert_eq!(at, At::exact(left, top));
        let part: Vec<u16> = (top..top + deep)
            .flat_map(|y| {
                let row = (y * SIZE.0 + left) * 3;
                before[row..row + wide * 3].to_vec()
            })
            .collect();
        assert_eq!(host(&under), part);
    }

    #[test]
    fn another_fill_drawn_instead_is_the_frame_drawn_with_it() {
        let before = striped_with_a_disc(SIZE, CENTRE);
        let bare = RetouchedFrame::drawn(upload(&before, SIZE.1), whole(), At::ORIGIN, &[])
            .expect("drawn");
        let offered = offered(&bare, None);
        let [shown, other] = [&offered[0], &offered[1]];
        let frame = RetouchedFrame::drawn(
            upload(&before, SIZE.1),
            whole(),
            At::ORIGIN,
            std::slice::from_ref(shown),
        )
        .expect("drawn");
        let chosen = RetouchedFrame::drawn(
            upload(&before, SIZE.1),
            whole(),
            At::ORIGIN,
            std::slice::from_ref(other),
        )
        .expect("drawn");
        let chosen = host(&chosen.frame);

        let (left, top, wide, deep) = (70, 50, 60, 60);
        let (instead, at) = frame
            .drawn_instead(Some(shown), other, Rect::exact(left, top, wide, deep))
            .expect("drawn instead");
        let (ax, ay) = at.raw();
        let (width, _) = instead.size();
        let instead = host(&instead);
        for y in top..top + deep {
            for x in left..left + wide {
                for channel in 0..3 {
                    let here = instead[((y - ay) * width + x - ax) * 3 + channel];
                    let there = chosen[(y * SIZE.0 + x) * 3 + channel];
                    assert!(here.abs_diff(there) <= 1, "{x},{y}: {here} against {there}");
                }
            }
        }
    }

    #[test]
    fn a_repair_reopened_is_searched_as_though_it_was_never_drawn() {
        let before = striped_with_a_disc(SIZE, CENTRE);
        let bare = RetouchedFrame::drawn(upload(&before, SIZE.1), whole(), At::ORIGIN, &[])
            .expect("drawn");
        let first = offered(&bare, None);
        let frame =
            RetouchedFrame::drawn(upload(&before, SIZE.1), whole(), At::ORIGIN, &first[..1])
                .expect("drawn");
        assert_eq!(offered(&frame, Some(&first[0])), first);
    }

    #[test]
    fn a_frame_redrawn_is_the_frame_drawn_with_the_new_repairs() {
        let before = striped_with_a_disc(SIZE, CENTRE);
        let bare = RetouchedFrame::drawn(upload(&before, SIZE.1), whole(), At::ORIGIN, &[])
            .expect("drawn");
        let offered = offered(&bare, None);
        let mut frame =
            RetouchedFrame::drawn(upload(&before, SIZE.1), whole(), At::ORIGIN, &offered[..1])
                .expect("drawn");

        frame.redraw(&offered[1..2]).expect("redrawn");
        let chosen =
            RetouchedFrame::drawn(upload(&before, SIZE.1), whole(), At::ORIGIN, &offered[1..2])
                .expect("drawn");
        assert_eq!(host(&frame.frame), host(&chosen.frame));
        assert!(frame.original_under(&offered[0], everything()).is_err());
        let (under, _) = frame
            .original_under(&offered[1], everything())
            .expect("under");
        assert_eq!(host(&under), before);

        frame.redraw(&[]).expect("redrawn");
        assert_eq!(host(&frame.frame), before);
    }

    #[test]
    fn rows_written_carry_their_originals_and_drop_a_repair_the_band_lost() {
        let before = striped_with_a_disc(SIZE, CENTRE);
        let bare = RetouchedFrame::drawn(upload(&before, SIZE.1), whole(), At::ORIGIN, &[])
            .expect("drawn");
        let repair = offered(&bare, None).remove(0);
        let mut frame = bare;
        assert!(frame.original_under(&repair, everything()).is_err());

        // Two bands meeting across the repair, the second reaching the frame's last row and holding
        // none of the rows its fill is read from.
        for (top, deep) in [(0, 80), (80, SIZE.1 - 80)] {
            let band = RetouchedFrame::drawn(
                upload(rows(&before, top, deep), deep),
                whole(),
                At::exact(0, top),
                std::slice::from_ref(&repair),
            )
            .expect("band");
            frame.write_rows(band, 0, deep, top).expect("written");
        }
        assert_ne!(host(&frame.frame), before, "the bands drew nothing");
        let (under, _) = frame.original_under(&repair, everything()).expect("under");
        assert_eq!(host(&under), before);

        let band =
            RetouchedFrame::drawn(upload(rows(&before, 0, 10), 10), whole(), At::ORIGIN, &[])
                .expect("band");
        frame.write_rows(band, 0, 10, 0).expect("written");
        assert!(frame.original_under(&repair, everything()).is_err());
    }
}
