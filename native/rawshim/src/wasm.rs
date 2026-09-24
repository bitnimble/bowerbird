//! What a page calls: a photograph opened onto the module's own device, and every tick drawn on
//! it from there.
//!
//! **No pixels cross this boundary.** The frame is decoded, denoised, demosaiced, warped,
//! sharpened and graded on the device the worker opened, and the canvases the page hands over are
//! surfaces on that same device - so what the page sends is a region and a set of edits, and what
//! it gets back is a drawn frame. A picture that crossed would be 366MB at 61MP, and a copy either
//! side of it.

use wasm_bindgen::prelude::*;

/// Opens the page's adapter, refusing here rather than somewhere further down.
///
/// **There is no CPU arm to fall through to.** Every stage that makes a picture is a shader - the
/// conditioning, GALOSH, RCD, the coding, the defringe, the gather, the grade - so a tab without
/// WebGPU cannot decode a RAW at all, and `condition` simply declines. Left to fail there, what the
/// reader is told is that their file could not be read, which sends them looking at the photograph
/// instead of at the browser.
async fn needs_webgpu() -> Result<(), JsValue> {
    match crate::gpu::page_device().await {
        Some(_) => Ok(()),
        None => Err(JsValue::from_str(
            "rawshim: this pipeline runs entirely on the GPU and this browser offered no WebGPU \
             adapter, so there is nothing to run it on. Either the browser does not support \
             WebGPU, or it found no usable graphics device.",
        )),
    }
}

/// A photograph opened and kept at the mosaic, so a Detail slider costs a denoise and not a file.
///
/// **The frame below the denoise is a function of the amounts; everything above it is not.** The
/// read, the black levels, the white balance and the conditioning depend on the bytes alone, and
/// they are the seconds of an open. Held here, a slider re-runs the denoise, the demosaic and the
/// grade against a mosaic that is already on the device.
///
/// The fit is measured once for the same reason it is measured whole: Phase 0 reduces over
/// everything it is shown, so it describes the photograph rather than an amount, and re-measuring
/// per slider position would be sixteen reductions bought for nothing.
#[wasm_bindgen]
pub struct HeldRaw {
    /// The photograph at the mosaic, where this page decoded it for itself.
    ///
    /// **None for a picture that arrived coded** ([`hold_picture`]). A composite is several
    /// photographs and hundreds of megapixels, and a phone cannot hold one at all, so those are
    /// prepared where the files are and cross as the picture rather than as the sources. What is
    /// then absent is every stage *below* the coding - the denoise, the demosaic, the dust search -
    /// which is exactly the set of things this holds a mosaic in order to re-run, so the four
    /// methods that re-run them refuse by name and the page does not offer them.
    ///
    /// Everything above the coding is shared, and that is the point: one `tick`, one grade, one
    /// set of canvases, whichever device prepared the picture.
    held: Option<crate::decode::Held>,
    /// The file, kept because the camera match is fitted against its embedded JPEG.
    ///
    /// Empty for a finished picture, which has no preview to fit against (`edit::from_frame`
    /// takes `Fitting::None` for one) and whose codes are already on the device: a 48MP 16-bit
    /// PNG would otherwise sit in the page's heap for the life of the open beside the copy the
    /// kernel reads. What still reads this is the two magic tests, and both answer the same on an
    /// empty slice as on the file - neither PNG's signature nor a JPEG's `FFD8` matches nothing.
    bytes: Vec<u8>,
    /// Whether this photograph has a sensor behind it, which is what decides the two things
    /// `bytes` would otherwise be sniffed for on every prepare.
    mosaic: bool,
    fit: Option<crate::galosh::NoiseFit>,
    request: crate::edit::EditRequest,
    /// The photograph's diffuse white and scene peak, as the last whole-frame prepare measured
    /// them. A band is handed these rather than measuring its own: a quantile of one strip
    /// describes that strip, so bands measuring themselves are graded against a white that walks
    /// down the frame. `Cell` because a page is one thread and `prepare` takes `&self`.
    levels: std::cell::Cell<Option<crate::tone::Levels>>,
    /// What this photograph's own open measured, where the page had nothing to hand it.
    ///
    /// Held for the reason the levels are: a band takes its lens off the request, so without this
    /// the strips of a photograph nothing had fitted before gather through no lens at all, while
    /// the frame under them was warped through the one this open fitted.
    analysis: std::cell::RefCell<Option<Vec<u8>>>,
    /// The aberration the open's defringe took off, for the same reason and with the same failure:
    /// the fit is whole-frame, so a strip fitting its own is corrected by its own edges.
    defocus: std::cell::Cell<Option<(f32, f32)>>,
    /// The frame this photograph draws from, and everything the grade binds beside it.
    ///
    /// Replaced by each `prepare`, which is what a Detail slider is: the frame changes and the
    /// canvases it draws onto do not.
    drawing: std::cell::RefCell<Option<Drawing>>,
    /// The canvases the page handed over, kept across prepares for that reason.
    stage: std::cell::RefCell<Option<crate::gpu::Stage>>,
    loupe: std::cell::RefCell<Option<crate::gpu::Stage>>,
    /// The canvas the last repair thumbnail was drawn onto, kept until the page has copied it out.
    thumbnail: std::cell::RefCell<Option<crate::gpu::Stage>>,
    /// The rendition tile under the glass, where one has been built for where it is pointing.
    tile: std::cell::RefCell<Option<Tiled>>,
    /// The tiles of the picture this open is holding, newest use last.
    ///
    /// **The unit that makes a pan cost the part that is new.** A window refetched whole is mostly
    /// content already on this device, so what is kept is a grid of [`crate::tile_grid::TILE`]
    /// squares and what is asked for is the squares a viewport has reached that are not here yet.
    held_tiles: std::cell::RefCell<Vec<Patch>>,
    /// The level and the rectangle of it the stage last asked the tiles for, which a change of
    /// repairs draws again.
    shown: std::cell::Cell<Option<((usize, usize), (usize, usize), (usize, usize))>>,
    /// The repairs drawn over a frame assembled from tiles (`set_repairs`). A local open's are in
    /// its prepare instead, and this stays empty.
    repairs: std::cell::RefCell<Vec<crate::repair::Repair>>,
    /// A loop about to be searched around, whose search a frame assembled from tiles holds as well
    /// as the stage (`set_searched`).
    searched: std::cell::RefCell<Option<(Vec<crate::px::Point<crate::px::Stored>>, Option<Donor>)>>,
    /// Counts uses, so the oldest tile is the one eviction takes.
    tick: std::cell::Cell<u64>,
    /// What a tick that named no region draws, and what the reader's crop moves.
    geometry: std::cell::Cell<crate::image::Geometry>,
    adjust: std::cell::Cell<crate::gpu::Adjust>,
    /// Which output the reader is proofing against, which the draw grades and clips for.
    proof: std::cell::Cell<crate::gpu::Output>,
    /// How an sRGB proof fits its highlights under diffuse white.
    proof_tone: std::cell::Cell<crate::gpu::Tonemap>,
    /// Whether the display shows light past SDR white, which caps every draw's peak when it does not.
    display_hdr: std::cell::Cell<bool>,
    print: std::cell::Cell<Option<crate::print::Scene>>,
    /// What an open answered with, for a picture that arrived already prepared.
    ///
    /// `prepare` returns this as its result and keeps nothing; a picture handed over coded was
    /// described before it got here, so the description is kept and asked for
    /// ([`HeldRaw::header`]) rather than recomputed. Empty for a local open, which has no second
    /// answer to give.
    header: String,
}

/// One rendition tile, on the device, with the grade's resources over it.
///
/// No pyramid of its own: a tile is only ever magnified, so the draw reads its buffer at whatever
/// ratio and the frame's pyramid is bound at the slot the shader will not sample.
///
/// No scene peak of its own either, and that one is not an economy: the tile is uploaded against
/// the *frame's* peak, already measured and so never re-run. A tile that measured its own would
/// read the top end of a few hundred thousand photosites - over a dark part of the picture, a
/// diffuse white - and roll its highlights off a knee the stage underneath put somewhere else,
/// which is the one thing a magnifier held against the picture may not do.
struct Tiled {
    _frame: crate::resident::Resident,
    uploaded: crate::gpu::Uploaded<'static>,
    window: crate::tile::Prepared,
    peak_nits: crate::light::Light<crate::light::DisplayNits>,
}

use crate::tile_grid::{tile_rect, tiles_over};

/// How much of the picture this open will hold in tiles before the oldest go.
///
/// A viewport and the ring around it is a handful; this is room for a reader to pan away and back
/// without paying for the way back, and a bound on a tab that pans across a canvas all afternoon.
const TILE_BUDGET_BYTES: usize = 512 * 1024 * 1024;

/// One tile of one level, on the device.
struct Patch {
    /// The level's own shape, which is what tells two levels' tiles apart - a level number would
    /// do as well, and this is what the draw needs anyway.
    level: (usize, usize),
    column: usize,
    row: usize,
    /// Where it sits in its level and how big it is. The last column and row are short.
    at: (usize, usize),
    size: (usize, usize),
    rgb: crate::resident::Resident,
    /// When it was last wanted, so the oldest are the ones that go.
    used: u64,
}

impl Patch {
    fn bytes(&self) -> usize {
        self.size.0 * self.size.1 * 6
    }
}

/// One prepared frame, on the device, with the grade's own resources built over it.
///
/// **Everything a tick reads, on the device the decode left it on.** The canvas comes to the frame
/// rather than the frame to the canvas, so nothing here is ever uploaded or read back: a tick
/// writes a uniform and draws.
struct Drawing {
    /// The frame and what its repairs were drawn over, which change together or not at all. Kept
    /// because `uploaded` binds the frame by handle: dropping it would destroy it under the grade.
    frame: crate::retouched_frame::RetouchedFrame,
    uploaded: crate::gpu::Uploaded<'static>,
    pyramid: crate::base::Pyramid,
    /// Held so the peak `quantile` wrote survives every tick that reads it.
    _peak: crate::gpu::ScenePeak,
    levels: crate::tone::Levels,
    matched: Option<crate::hdr_fit::HdrMatch>,
    as_shot: Option<crate::white_balance::AsShot>,
    width: usize,
    height: usize,
    /// Where this buffer sits in the picture, where it is a rectangle of a larger one.
    ///
    /// **`width`/`height` are the buffer and this is the picture, and past the coarsest level of a
    /// canvas they stop being the same numbers.** Everything the reader states is against the
    /// picture - the crop fractions, the region pan and zoom move, the reach of a presence slider -
    /// so a draw handed the buffer's size for either would crop a panorama to its viewport and
    /// clarify it as though the viewport were the photograph.
    placed: Option<crate::gpu::Window>,
    reference_nits: crate::light::Light<crate::light::SceneNits>,
    peak_nits: crate::light::Light<crate::light::DisplayNits>,
}

impl Drawing {
    /// The picture these samples are of, which is the buffer unless they are a window of one.
    fn picture(&self) -> (usize, usize) {
        self.placed
            .map_or((self.width, self.height), |placed| placed.photograph.raw())
    }

    /// This photograph's grade at rest over a `width` by `height` buffer at `window`: what its
    /// resources are built from, before a tick moves anything.
    fn at_rest(
        &self,
        width: usize,
        height: usize,
        window: Option<crate::gpu::Window>,
    ) -> crate::gpu::Grade<'_> {
        let (picture_w, picture_h) = self.picture();
        crate::gpu::Grade {
            width,
            height,
            // The picture's, as every other grade over this frame reads it: a presence slider's
            // reach is a fraction of the photograph, and a window told its own size would filter at
            // the wrong scale.
            photograph_long: crate::px::Span::measured(picture_w.max(picture_h)),
            colour: self.matched.as_ref().and_then(|m| m.colour.as_ref()),
            white: self.levels.white,
            source_level: self.levels.peak,
            floor: self.levels.floor,
            reference_nits: self.reference_nits,
            peak_nits: self.peak_nits,
            exposure: crate::light::Stops::ZERO,
            adjust: crate::gpu::Adjust::none(),
            as_shot: self.as_shot,
            output: crate::gpu::Output::Pq,
            geometry: crate::image::Geometry::none(),
            window,
            surround_window: None,
            canvas: None,
            print_tone: crate::gpu::Tonemap::Neutral,
        }
    }
}

/// What a draw reads.
enum Reading<'a> {
    /// The editor's own frame.
    Frame,
    /// The rendition's tile under the glass.
    Tile(&'a Tiled),
    /// A `width` by `height` part of the picture at `window`, uploaded on its own.
    Part {
        uploaded: &'a crate::gpu::Uploaded<'static>,
        width: usize,
        height: usize,
        window: crate::gpu::Window,
    },
}

/// Opens a photograph as far as a setting can still move it and keeps it, for a page that will ask
/// for more than one Detail amount. `request` is [`crate::edit::EditRequest`] as JSON, without the
/// file path - the bytes are here.
///
/// A RAW is held at the mosaic and a finished picture at its code values; which of the two this is
/// never reaches the page, because everything it then asks for is the same call
/// ([`crate::decode::Held`]).
#[wasm_bindgen(js_name = holdRaw)]
pub async fn hold_raw(bytes: &[u8], request: &str) -> Result<HeldRaw, JsValue> {
    needs_webgpu().await?;
    let request: crate::edit::EditRequest = serde_json::from_str(request)
        .map_err(|e| JsValue::from_str(&format!("rawshim: this open request is malformed: {e}")))?;
    let rendered = crate::decode_rendered::is_rendered_bytes(bytes);
    let held = crate::decode::hold_bytes(bytes)
        .await
        .map_err(|why| JsValue::from_str(&format!("rawshim: {why}")))?;
    let fit = held.fit().await;
    // The abnormal cases say so, because their only other symptom is a photograph that is not
    // denoised and nothing on the page reports why. A finished picture has no mosaic to fit and
    // nothing to denoise, so its `None` is the answer rather than a failure.
    match fit {
        Some(fit) if !fit.usable() => crate::warn(&format!(
            "rawshim: this frame's noise fit is not one to filter with, so it is not denoised: {fit:?}"
        )),
        None if !rendered => {
            crate::warn("rawshim: no noise fit was measured, so nothing will be denoised");
        }
        _ => {}
    }
    let fit = fit.filter(crate::galosh::NoiseFit::usable);
    Ok(HeldRaw {
        held: Some(held),
        bytes: match rendered {
            true => Vec::new(),
            false => bytes.to_vec(),
        },
        mosaic: !rendered,
        fit,
        request,
        levels: std::cell::Cell::new(None),
        analysis: std::cell::RefCell::new(None),
        defocus: std::cell::Cell::new(None),
        drawing: std::cell::RefCell::new(None),
        stage: std::cell::RefCell::new(None),
        loupe: std::cell::RefCell::new(None),
        thumbnail: std::cell::RefCell::new(None),
        tile: std::cell::RefCell::new(None),
        held_tiles: std::cell::RefCell::new(Vec::new()),
        shown: std::cell::Cell::new(None),
        repairs: std::cell::RefCell::new(Vec::new()),
        searched: std::cell::RefCell::new(None),
        tick: std::cell::Cell::new(0),
        geometry: std::cell::Cell::new(crate::image::Geometry::none()),
        adjust: std::cell::Cell::new(crate::gpu::Adjust::none()),
        proof: std::cell::Cell::new(crate::gpu::Output::Pq),
        proof_tone: std::cell::Cell::new(crate::gpu::Tonemap::Neutral),
        display_hdr: std::cell::Cell::new(true),
        print: std::cell::Cell::new(None),
        header: String::new(),
    })
}

/// Opens a picture somebody else prepared, uploading it to this page's device.
///
/// **What lets the editor open a composite.** A panorama is several photographs and a canvas of
/// hundreds of megapixels; nothing about holding one in a tab is affordable, and on a phone it is
/// not possible. So the picture is prepared where the files are and crosses coded - normalised PQ
/// Rec.2020, exactly what this page's own open leaves on the device - and every tick after that is
/// the tick a local open gets, over the same WGSL, because the frame is in the same form.
///
/// `framed` is `ffi::bb_prepare_picture`'s reply, whole: a `u32` header length, that much
/// [`crate::edit::PreparedHeader`] as JSON, zero padding to a word, then the samples. Read here
/// rather than split by the page, so the one place that knows the layout is the one that states
/// it.
///
/// There is no mosaic behind this and there cannot be, so the Detail and Dust panels have nothing
/// to act on: a new amount is a new prepare, which is the caller's to ask for.
#[wasm_bindgen(js_name = holdPicture)]
pub async fn hold_picture(framed: &[u8], request: &str) -> Result<HeldRaw, JsValue> {
    needs_webgpu().await?;
    let request: crate::edit::EditRequest = serde_json::from_str(request)
        .map_err(|e| JsValue::from_str(&format!("rawshim: this open request is malformed: {e}")))?;
    let mut held = HeldRaw {
        held: None,
        bytes: Vec::new(),
        mosaic: false,
        fit: None,
        request,
        levels: std::cell::Cell::new(None),
        analysis: std::cell::RefCell::new(None),
        defocus: std::cell::Cell::new(None),
        drawing: std::cell::RefCell::new(None),
        stage: std::cell::RefCell::new(None),
        loupe: std::cell::RefCell::new(None),
        thumbnail: std::cell::RefCell::new(None),
        tile: std::cell::RefCell::new(None),
        held_tiles: std::cell::RefCell::new(Vec::new()),
        shown: std::cell::Cell::new(None),
        repairs: std::cell::RefCell::new(Vec::new()),
        searched: std::cell::RefCell::new(None),
        tick: std::cell::Cell::new(0),
        geometry: std::cell::Cell::new(crate::image::Geometry::none()),
        adjust: std::cell::Cell::new(crate::gpu::Adjust::none()),
        proof: std::cell::Cell::new(crate::gpu::Output::Pq),
        proof_tone: std::cell::Cell::new(crate::gpu::Tonemap::Neutral),
        display_hdr: std::cell::Cell::new(true),
        print: std::cell::Cell::new(None),
        header: String::new(),
    };
    held.take_picture(framed)?;
    Ok(held)
}

/// One rendition of a photograph, rendered here for the server to encode: `job` is
/// [`crate::job::Job`] as JSON naming one target, and the answer is [`crate::job::render_bytes`]'s
/// frame.
#[wasm_bindgen(js_name = renderRendition)]
pub async fn render_rendition(bytes: &[u8], job: &str) -> Result<Vec<u8>, JsValue> {
    needs_webgpu().await?;
    let job: crate::job::Job = serde_json::from_str(job)
        .map_err(|e| JsValue::from_str(&format!("rawshim: this job is malformed: {e}")))?;
    crate::job::render_bytes(&job, bytes)
        .await
        .map_err(|why| JsValue::from_str(&format!("rawshim: {why}")))
}

#[wasm_bindgen(js_name = finishDraw)]
pub async fn finish_draw() -> Result<(), JsValue> {
    let gpu = crate::gpu::device()
        .ok_or_else(|| JsValue::from_str("rawshim: this browser offered no WebGPU adapter"))?;
    crate::gpu::finished(gpu).await
        .ok_or_else(|| JsValue::from_str("rawshim: the GPU did not finish the draw"))?;
    refused()
}

/// A refusal the device reported since the last draw.
fn refused() -> Result<(), JsValue> {
    match crate::gpu::refusal() {
        Some(said) => Err(JsValue::from_str(&said)),
        None => Ok(()),
    }
}

/// The document's repairs, as the page sends them.
fn repairs_of(json: &str) -> Result<Vec<crate::repair::Repair>, JsValue> {
    serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&format!("rawshim: these repairs are malformed: {e}")))
}

/// Which filter the Detail panel is driving, as the document spells it.
fn denoiser_of(name: &str) -> Result<crate::galosh::Denoiser, JsValue> {
    serde_json::from_str(&format!("\"{name}\""))
        .map_err(|_| JsValue::from_str(&format!("rawshim: {name} is not a denoiser")))
}

/// PMRID's weights, which the page fetches rather than carrying in this module.
///
/// **Four megabytes that would otherwise be in every reader's download.** The module's name is its
/// own hash, so a build that changes one line of Rust re-fetches everything in it; served apart,
/// these are cached apart and only a reader who chooses the network asks for them at all. Handing
/// them over is what makes `pmrid::device` answer, so the page does it before the first prepare
/// that names PMRID rather than at startup.
#[wasm_bindgen(js_name = holdPmridWeights)]
pub fn hold_pmrid_weights(bytes: Vec<u8>) {
    crate::pmrid::hold_weights(bytes);
}

/// Where a fill is read from, from where it lands, on the `px::Stored` grid.
type Donor = [crate::px::Extent<crate::px::Stored>; 2];

fn donor_of(json: &str) -> Result<Donor, JsValue> {
    let donor: [i32; 2] = serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&format!("rawshim: this donor is malformed: {e}")))?;
    Ok(donor.map(|step| crate::px::Extent::exactly(f64::from(step))))
}

fn repair_of(json: &str) -> Result<crate::repair::Repair, JsValue> {
    serde_json::from_str(json)
        .map_err(|e| JsValue::from_str(&format!("rawshim: this repair is malformed: {e}")))
}

/// A framed reply's halves: the header, the text it was read from, and the samples past it.
///
/// The text comes back so the page can be handed the description it already has rather than a
/// re-serialisation of it - the same string `prepare` answers with, for the same reader.
///
/// The twin of `ffi::frame`, and `edit::samples_at` is the offset both use: a length misread here
/// is not a wrong pixel, it is a picture of noise or a slice that runs off the buffer.
fn unframe(framed: &[u8]) -> Result<(crate::edit::PreparedHeader, String, Vec<u16>), JsValue> {
    let malformed = |why: &str| JsValue::from_str(&format!("rawshim: {why}"));
    let length = framed
        .get(0..4)
        .map(|word| u32::from_le_bytes([word[0], word[1], word[2], word[3]]) as usize)
        .ok_or_else(|| malformed("this prepared picture came back with no header"))?;
    // Bounded before it is rounded up: this word came off a socket, and a length near `u32::MAX`
    // overflows the alignment below rather than failing the slice after it.
    if length > framed.len() {
        return Err(malformed(
            "this prepared picture's header runs past its buffer",
        ));
    }
    let text = framed
        .get(4..4 + length)
        .ok_or_else(|| malformed("this prepared picture's header runs past its buffer"))?;
    let described = std::str::from_utf8(text)
        .map_err(|e| malformed(&format!("this prepared picture's header is not text: {e}")))?;
    let header: crate::edit::PreparedHeader = serde_json::from_str(described)
        .map_err(|e| malformed(&format!("this prepared picture's header is malformed: {e}")))?;
    let at = crate::edit::samples_at(length);
    let body = framed
        .get(at..)
        .ok_or_else(|| malformed("this prepared picture has no samples"))?;
    if body.len() % 2 != 0 {
        return Err(malformed(
            "this prepared picture's samples are a half sample short",
        ));
    }
    Ok((
        header,
        described.to_owned(),
        body.chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect(),
    ))
}

#[wasm_bindgen]
impl HeldRaw {
    /// What part of the picture a region of the output reads from, as fractions of the picture.
    ///
    /// **A region is in output pixels and a window is cut from the picture, and the reader's
    /// geometry is what stands between them.** The crop moves the origin, the turn swaps the axes,
    /// the straighten rotates - so a client dividing its region by the output's size and sending
    /// that would name a rectangle somewhere else in the canvas, and a panorama framed off-centre
    /// by its own align is enough to see it.
    ///
    /// Asked of the module rather than worked out by the page, because the module already does
    /// exactly this mapping for every pixel it draws ([`crate::image::geometry_at`]) - a second
    /// implementation on the page is a second answer waiting to drift from the one on screen.
    ///
    /// The *bounding box* of the mapped region, and over-covered rather than exact: under a
    /// straighten the mapping sends a rectangle to a rotated quadrilateral, and a window is a
    /// rectangle. Sampled around the border rather than at the corners alone, because a keystone
    /// is not linear and a bowed edge can reach past every corner.
    #[wasm_bindgen(js_name = picturePart)]
    pub fn picture_part(&self, region: &str) -> Result<String, JsValue> {
        let mut region: crate::gpu::Region = serde_json::from_str(region)
            .map_err(|e| JsValue::from_str(&format!("rawshim: this region is malformed: {e}")))?;
        if let Some(scene) = self.print.get() {
            let held = self.drawing.borrow();
            if let Some(drawing) = held.as_ref() {
                let picture = drawing.picture();
                let shape = crate::hdr::cropped_size(picture.0, picture.1, self.geometry.get());
                (region.x, region.y, region.width, region.height) = scene.photo_region(
                    shape, (region.x, region.y, region.width, region.height));
            }
        }
        let [x, y, wide, deep] = self.part_of(&region)?;
        Ok(format!("[{x},{y},{wide},{deep}]"))
    }

    /// [`Self::picture_part`], as the fractions `[x, y, width, height]`.
    fn part_of(&self, region: &crate::gpu::Region) -> Result<[f64; 4], JsValue> {
        let held = self.drawing.borrow();
        let Some(drawing) = held.as_ref() else {
            return Err(JsValue::from_str("rawshim: no picture is open to measure"));
        };
        let picture = drawing.picture();
        let geometry = self.geometry.get();
        let out = crate::hdr::cropped_size(picture.0, picture.1, geometry);
        let (mut low, mut high) = ([f64::MAX; 2], [f64::MIN; 2]);
        const ROUND: usize = 16;
        for step in 0..=ROUND {
            let along = step as f64 / ROUND as f64;
            for (x, y) in [
                (region.x + along * region.width, region.y),
                (region.x + along * region.width, region.y + region.height),
                (region.x, region.y + along * region.height),
                (region.x + region.width, region.y + along * region.height),
            ] {
                let (px, py) = crate::image::geometry_at(picture, out, geometry, x, y);
                low = [low[0].min(px), low[1].min(py)];
                high = [high[0].max(px), high[1].max(py)];
            }
        }
        let across = |value: f64, span: usize| (value / span.max(1) as f64).clamp(0.0, 1.0);
        let (x, y) = (across(low[0], picture.0), across(low[1], picture.1));
        Ok([
            x,
            y,
            across(high[0], picture.0) - x,
            across(high[1], picture.1) - y,
        ])
    }

    /// Points of the output under `geometry`, as fractions of it, where they are in the picture, as
    /// fractions of that. `picturePart`'s reason for asking the module, a point at a time: what a
    /// reader draws on the stage, onto the picture a repair is a place on.
    #[wasm_bindgen(js_name = pictureOfOutput)]
    pub fn picture_of_output(&self, geometry: &str, points: &str) -> Result<String, JsValue> {
        self.mapped(geometry, points, |picture, out, geometry, [x, y]| {
            let (px, py) = crate::image::geometry_at(
                picture,
                out,
                geometry,
                x * out.0 as f64,
                y * out.1 as f64,
            );
            [px / picture.0 as f64, py / picture.1 as f64]
        })
    }

    /// [`Self::picture_of_output`] backwards: where points of the picture are drawn on the stage.
    #[wasm_bindgen(js_name = outputOfPicture)]
    pub fn output_of_picture(&self, geometry: &str, points: &str) -> Result<String, JsValue> {
        self.mapped(geometry, points, |picture, out, geometry, [x, y]| {
            let (ox, oy) = crate::image::output_at(
                picture,
                out,
                geometry,
                x * picture.0 as f64,
                y * picture.1 as f64,
            );
            [ox / out.0 as f64, oy / out.1 as f64]
        })
    }

    fn mapped(
        &self,
        geometry: &str,
        points: &str,
        map: impl Fn((usize, usize), (usize, usize), crate::image::Geometry, [f64; 2]) -> [f64; 2],
    ) -> Result<String, JsValue> {
        let malformed = |what: &str, e: serde_json::Error| {
            JsValue::from_str(&format!("rawshim: this {what} is malformed: {e}"))
        };
        let geometry: crate::image::Geometry =
            serde_json::from_str(geometry).map_err(|e| malformed("geometry", e))?;
        let points: Vec<[f64; 2]> =
            serde_json::from_str(points).map_err(|e| malformed("list of points", e))?;
        let held = self.drawing.borrow();
        let Some(drawing) = held.as_ref() else {
            return Err(JsValue::from_str("rawshim: no picture is open to measure"));
        };
        let picture = drawing.picture();
        let out = crate::hdr::cropped_size(picture.0, picture.1, geometry);
        let mapped: Vec<[f64; 2]> = points
            .into_iter()
            .map(|point| map(picture, out, geometry, point))
            .collect();
        serde_json::to_string(&mapped).map_err(|e| JsValue::from_str(&format!("rawshim: {e}")))
    }

    /// What this open is short of to draw `rect` of `level`, and what it draws once it is not.
    ///
    /// **The page owns the network and this owns the tiles**, which is the whole of the split. It
    /// answers `{"missing":[[left,top,width,height],…]}` with the squares to fetch and hand to
    /// [`Self::takeTiles`], or `{"missing":null}` having assembled the frame a tick will draw. A
    /// page calls it, fetches what it is told to, hands that back, and calls again.
    ///
    /// Every square, not their box. One request covers the lot - a prepare's fixed cost is per
    /// source, so one pass beats one each - but the library is told the squares as well, so an L
    /// of them is decoded per source for the box bounding *that source's* own squares and a source
    /// no square reaches is never opened.
    ///
    /// `rect` is in the level's own pixels and is the viewport *already dilated* by however far
    /// ahead the page wants to load - the tiles a reader is approaching are just a larger
    /// rectangle, so there is nothing here that has to know about a gesture.
    #[wasm_bindgen(js_name = showTiles)]
    pub fn show_tiles(&self, level: &str, rect: &str) -> Result<String, JsValue> {
        let malformed = |what: &str, e: serde_json::Error| {
            JsValue::from_str(&format!("rawshim: this {what} is malformed: {e}"))
        };
        let level: (usize, usize) =
            serde_json::from_str(level).map_err(|e| malformed("level", e))?;
        let rect: (usize, usize, usize, usize) =
            serde_json::from_str(rect).map_err(|e| malformed("rectangle", e))?;
        if level.0 == 0 || level.1 == 0 {
            return Err(JsValue::from_str(
                "rawshim: a level of no pixels holds no tiles",
            ));
        }
        let at = (rect.0.min(level.0 - 1), rect.1.min(level.1 - 1));
        let size = (rect.2.max(1), rect.3.max(1));
        self.shown.set(Some((level, at, size)));
        self.show(level, at, size)
    }

    /// The reader's repairs, for a picture prepared elsewhere: drawn over every frame this open
    /// assembles from its tiles, as the local open's prepare draws them (`tile::prepared_on_device`).
    ///
    /// Answers as [`Self::showTiles`] does for what is on the stage: `{"missing":null}` having drawn
    /// them, or the squares a fill is read from that are not here yet.
    #[wasm_bindgen(js_name = setRepairs)]
    pub fn set_repairs(&self, repairs: &str) -> Result<String, JsValue> {
        self.repairs.replace(repairs_of(repairs)?);
        self.reshow()
    }

    /// A loop on the `px::Stored` grid about to be handed to [`Self::solveRepair`], or `null` once
    /// it has been: a frame assembled from tiles holds all its search reads, so the search looks as
    /// far over a composite as over a photograph this page decoded whole. Answers as `setRepairs`.
    /// `donor` is where the reader put the loop's fill, which is held too.
    #[wasm_bindgen(js_name = setSearched)]
    pub fn set_searched(&self, drawn: &str, donor: Option<String>) -> Result<String, JsValue> {
        let drawn: Option<Vec<[u16; 2]>> = serde_json::from_str(drawn)
            .map_err(|e| JsValue::from_str(&format!("rawshim: this loop is malformed: {e}")))?;
        let drawn = drawn
            .map(crate::repair::loop_of)
            .transpose()
            .map_err(|why| JsValue::from_str(&why))?;
        let donor = donor.as_deref().map(donor_of).transpose()?;
        self.searched.replace(drawn.map(|drawn| (drawn, donor)));
        self.reshow()
    }

    /// Lets every tile go, for a picture prepared again at other settings: a tile kept from before
    /// would be drawn beside the new ones as a second picture. The frame on the stage stays until
    /// the next is assembled.
    #[wasm_bindgen(js_name = dropTiles)]
    pub fn drop_tiles(&self) {
        for patch in self.held_tiles.borrow_mut().drain(..) {
            patch.rgb.reclaim();
        }
    }

    /// What the stage last asked the tiles for, again.
    fn reshow(&self) -> Result<String, JsValue> {
        match self.shown.get() {
            Some((level, at, size)) => self.show(level, at, size),
            None => Ok("{\"missing\":null}".to_owned()),
        }
    }

    /// `showTiles` for a rectangle already inside its level, grown to hold the search around a loop
    /// about to be solved and where the fills of the repairs reaching it are read from.
    fn show(
        &self,
        level: (usize, usize),
        at: (usize, usize),
        size: (usize, usize),
    ) -> Result<String, JsValue> {
        let whole = crate::px::Size::exact(level.0, level.1);
        let mut edges = [
            at.0,
            at.1,
            (at.0 + size.0).min(level.0),
            (at.1 + size.1).min(level.1),
        ];
        if let Some((drawn, donor)) = self.searched.borrow().as_ref() {
            let (left, top, wide, deep) = crate::repair_solve::searched(whole, drawn, *donor).raw();
            edges = [
                edges[0].min(left),
                edges[1].min(top),
                edges[2].max(left + wide),
                edges[3].max(top + deep),
            ];
        }
        let held = crate::repair::reaching(
            &self.repairs.borrow(),
            whole,
            crate::px::Rect::exact(edges[0], edges[1], edges[2] - edges[0], edges[3] - edges[1]),
            crate::px::Span::exact(0),
        );
        let (left, top, wide, deep) = held.raw();
        let (at, size) = ((left, top), (wide.max(1), deep.max(1)));

        let short = self.missing_over(level, at, size);
        if short.is_empty() {
            self.assemble(level, at, size)?;
            return Ok("{\"missing\":null}".to_owned());
        }
        let parts: Vec<String> = short
            .iter()
            .map(|(at, size)| format!("[{},{},{},{}]", at.0, at.1, size.0, size.1))
            .collect();
        Ok(format!("{{\"missing\":[{}]}}", parts.join(",")))
    }

    /// Keeps a prepared rectangle as the tiles it covers, for [`Self::showTiles`] to draw from.
    ///
    /// Answers the header it was given, which is what tells the page the level and the canvas the
    /// tiles it now holds belong to.
    ///
    /// `asked` is the list [`Self::showTiles`] answered with, handed back so only those squares
    /// are kept: the reply spans the box bounding them, and an L's corner is filled by whatever
    /// the sources reached rather than by its own picture. `"[]"` keeps everything the reply
    /// covers, which is what a whole level's window is.
    #[wasm_bindgen(js_name = takeTiles)]
    pub fn take_tiles(&self, framed: &[u8], asked: &str) -> Result<String, JsValue> {
        let squares: Vec<(usize, usize, usize, usize)> = serde_json::from_str(asked)
            .map_err(|e| JsValue::from_str(&format!("rawshim: these tiles are malformed: {e}")))?;
        let asked: Vec<((usize, usize), (usize, usize))> = squares
            .iter()
            .map(|(x, y, w, h)| ((*x, *y), (*w, *h)))
            .collect();
        let (header, described, samples) = unframe(framed)?;
        let (width, height) = (header.width, header.height);
        let wanted = width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(3))
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "rawshim: a {width}x{height} picture is not a picture"
                ))
            })?;
        if samples.len() != wanted {
            return Err(JsValue::from_str(&format!(
                "rawshim: a {width}x{height} picture is {wanted} samples and {} arrived",
                samples.len(),
            )));
        }
        self.keep_tiles(&header, &samples, &asked)?;
        Ok(described)
    }

    /// Another prepared picture of the same photograph, on the stage this open already has.
    ///
    /// **What a ladder costs the page: one call.** A reader zooming into a canvas is served a
    /// finer window of it, and the canvas it is drawn on cannot be transferred a second time - so
    /// the picture is replaced here rather than by opening again. Answers the same header
    /// [`Self::prepare`] does, which now says where in the picture these samples sit.
    #[wasm_bindgen(js_name = takePicture)]
    pub fn take_another(&mut self, framed: &[u8]) -> Result<String, JsValue> {
        self.take_picture(framed)?;
        Ok(self.header.clone())
    }

    /// The frame this photograph makes at these mosaic settings, kept on the device and answered
    /// with [`crate::edit::PreparedHeader`] as JSON - everything the page shows about the
    /// photograph, and nothing about its pixels.
    ///
    /// Filters a copy of the mosaic, so the next position starts from the same unfiltered frame
    /// rather than from this one's answer.
    #[wasm_bindgen(js_name = prepare)]
    pub async fn prepare(
        &self,
        luminance: Option<f64>,
        colour: Option<f64>,
        denoiser: &str,
        sharpen: f64,
        dust_enabled: bool,
        dust_sensitivity: f64,
        dust_intensity: f64,
        repairs: &str,
    ) -> Result<String, JsValue> {
        let repairs = repairs_of(repairs)?;
        // Undefined either side is the document not having said, which the decode answers with this
        // frame's own fit rather than with a number (`galosh::Detail`).
        let detail = crate::galosh::Detail { luminance, colour, denoiser: denoiser_of(denoiser)? };
        // The photograph's own fit where one was measured, which is what a region would be
        // denoised at too - never a fit of whatever this amount happens to produce.
        let fit = self
            .fit
            .map_or(crate::galosh::Fit::Measure, crate::galosh::Fit::Given);
        let settings = crate::dust::Settings {
            enabled: dust_enabled,
            sensitivity: dust_sensitivity,
            intensity: dust_intensity,
        };
        self.look_for_dust(settings).await;
        let request = crate::edit::EditRequest {
            repairs,
            ..self.opened_as()
        };
        let stored = request.stored();
        let frame = self
            .mosaic_held()?
            .frame(
                detail,
                self.request.long_edge,
                fit,
                // Always given, never measured: the looking is `look_for_dust`'s above, so that a
                // whole-frame prepare and a band of one are answered from the same list. The decode
                // detecting for itself here would find them a second time on every slider move.
                settings.wanted(Some(stored.from_raw.dust.as_deref().unwrap_or(&[]))),
            )
            .await
            .ok_or_else(|| JsValue::from_str("rawshim: the held mosaic would not finish"))?;
        let opened = crate::edit::from_frame(frame, &self.bytes, self.mosaic, &request, sharpen)
            .await
            .map_err(|e| JsValue::from_str(&format!("rawshim: {e}")))?;
        // Kept for the bands, which must not measure their own.
        self.levels.set(Some(crate::tone::Levels {
            white: opened.header.white,
            peak: opened.header.peak,
            floor: opened.header.floor,
        }));
        self.defocus.set(Some(opened.header.defocus));
        if opened.header.photo_analysis.is_some() {
            self.analysis.replace(opened.header.photo_analysis.clone());
        }
        let header = serde_json::to_string(&opened.header)
            .map_err(|e| JsValue::from_str(&format!("rawshim: {e}")))?;
        self.hold_drawing(opened)?;
        Ok(header)
    }

    /// Builds the grade's resources over the frame this open produced, and keeps them.
    ///
    /// The curves, the lattice and the pyramid are per frame-and-size, so they are built here
    /// rather than per tick. The blur is not: `Uploaded::detail_for` builds it the first time a
    /// grade whose `Adjust` reads the neighbourhood asks for it, and a 1x1 placeholder stands in
    /// until then, so a reader who never touches those sliders never pays for it.
    fn hold_drawing(&self, opened: crate::edit::Opened) -> Result<(), JsValue> {
        let refused = || JsValue::from_str("rawshim: this browser offered no WebGPU adapter");
        let gpu = crate::gpu::device().ok_or_else(refused)?;
        let base = crate::base::device(gpu).ok_or_else(refused)?;
        let (width, height) = (opened.header.width, opened.header.height);
        // The buffer's own, and the shader agrees: `geometry_at` takes the window's origin off
        // before dividing by the level's shrink, so a pyramid built over a window is indexed by
        // exactly what it hands back. What a window's pyramid cannot do is reach a neighbouring
        // part of the canvas, and `outside` leaves a tap that tries black - which is the edge of
        // what the reader asked to see.
        let placed = opened.header.window.map(|placed| crate::gpu::Window {
            photograph: crate::px::Size::exact(placed.canvas.0, placed.canvas.1),
            origin: crate::px::At::exact(placed.origin.0, placed.origin.1),
        });
        let (picture_w, picture_h) =
            placed.map_or((width, height), |placed| placed.photograph.raw());
        let pyramid = opened.frame.pyramid(base).ok_or_else(|| {
            JsValue::from_str(&format!(
                "rawshim: a {width}x{height} frame needs a {}px texture for the blur the \
                     presence sliders read, and this adapter allows {}px",
                width.max(height) / 2,
                gpu.limits().max_texture_dimension_2d,
            ))
        })?;
        let peak = gpu.scene_peak();
        let grade = crate::gpu::Grade {
            width,
            height,
            // The picture's, not the buffer's: a presence slider's reach is a fraction of the
            // photograph, and a window told its own size would filter at the wrong scale.
            photograph_long: crate::px::Span::measured(picture_w.max(picture_h)),
            // Unfiltered by the profile: a tick grades either way over this upload, and the
            // matched arm reads what it builds from the match.
            colour: opened.matched.as_ref().and_then(|m| m.colour.as_ref()),
            white: opened.levels.white,
            source_level: opened.levels.peak,
            floor: opened.levels.floor,
            reference_nits: self.request.grade.reference_white_nits,
            peak_nits: self.request.grade.peak_nits,
            exposure: crate::light::Stops::ZERO,
            adjust: crate::gpu::Adjust::none(),
            as_shot: opened.as_shot,
            output: crate::gpu::Output::Pq,
            geometry: crate::image::Geometry::none(),
            window: placed,
            surround_window: None,
            canvas: None,
            print_tone: crate::gpu::Tonemap::Neutral,
        };
        let uploaded = opened.frame.upload(&grade, &peak);
        // **The brightest of the sampled million, kept so a tick can re-measure without a sweep.**
        // The upload above measured the peak at rest; every tick after this one grades at an
        // exposure the reader has moved, and the peak is measured *after* that gain
        // (`peak.slang`) - so it is not a property of the frame and cannot be read once. What
        // makes re-reading affordable is this: `draw` grades these few thousand again instead of
        // the frame, which `the_kept_candidates_answer_as_the_whole_sample_does` pins as the same
        // answer.
        uploaded.collect_candidates(&grade);
        self.drawing.replace(Some(Drawing {
            frame: opened.frame,
            uploaded,
            pyramid,
            _peak: peak,
            levels: opened.levels,
            matched: opened.matched,
            as_shot: opened.as_shot,
            width,
            height,
            placed,
            reference_nits: self.request.grade.reference_white_nits,
            peak_nits: self.request.grade.peak_nits,
        }));
        Ok(())
    }

    /// Takes the stage's canvas, which the page transferred into this worker.
    ///
    /// **The canvas comes to the frame because the frame cannot go to the canvas.** A `GPUDevice`
    /// does not cross a worker boundary and neither does a texture, so a stage owned by the page
    /// could only be drawn by sending it the samples - which is the transfer per open this whole
    /// path exists to delete.
    #[wasm_bindgen(js_name = attachStage)]
    pub fn attach_stage(
        &self,
        canvas: web_sys::OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        self.attach(&self.stage, canvas, width, height)
    }

    /// The same, for the loupe: a second canvas over the first, drawn from the same frame.
    #[wasm_bindgen(js_name = attachLoupe)]
    pub fn attach_loupe(
        &self,
        canvas: web_sys::OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        self.attach(&self.loupe, canvas, width, height)
    }

    /// What this open answered with, for a picture that arrived already prepared.
    ///
    /// Empty for a local open, whose answer is `prepare`'s return value.
    #[wasm_bindgen(js_name = header)]
    pub fn header(&self) -> String {
        self.header.clone()
    }

    /// Lets the loupe's canvas go, the glass having been put down.
    #[wasm_bindgen(js_name = releaseLoupe)]
    pub fn release_loupe(&self) {
        self.loupe.replace(None);
    }

    /// Builds one rendition tile and keeps it, for the loupe to draw instead of the frame.
    ///
    /// **The glass shows what the export ships.** A tick's frame is denoised and sharpened for a
    /// stage, where a tile goes through the rendition's own chain at 1:1 - and a loupe is the one
    /// magnification where the difference is visible. Held rather than drawn once: a pointer sweep
    /// inside one tile is dozens of draws from the same buffer.
    ///
    /// Returns the window's `keep` rectangle, which is what the page positions the glass by.
    #[wasm_bindgen(js_name = holdTile)]
    pub async fn hold_tile(&self, request: &str) -> Result<String, JsValue> {
        let request: crate::tile::TileRequest = serde_json::from_str(request).map_err(|e| {
            JsValue::from_str(&format!("rawshim: this tile request is malformed: {e}"))
        })?;
        let held = self.mosaic_held()?;
        let request = self.off_the_held_mosaic(request);
        let (frame, window) =
            crate::tile::prepared_on_device(crate::tile::Source::Held(held), &request)
                .await
                .map_err(|e| JsValue::from_str(&format!("rawshim: {e}")))?;
        let frame = frame.into_frame();
        let refused = || JsValue::from_str("rawshim: this browser offered no WebGPU adapter");
        let gpu = crate::gpu::device().ok_or_else(refused)?;
        let scene = window.scene(crate::light::Stops::ZERO, crate::gpu::Adjust::none());
        let grade = window.grade(&scene, request.grade.peak_nits, crate::gpu::Output::Pq);
        // **The photograph's peak, not this crop's**, which is why it is taken off the drawing:
        // it has already been claimed, so the upload measures nothing and the tile binds the same
        // four words the stage grades through. Borrowed after the await above, since a `RefCell`
        // may not be held across one.
        let held = self.drawing.borrow();
        let Some(drawing) = held.as_ref() else {
            return Err(JsValue::from_str(
                "rawshim: no photograph is open to cut a tile from",
            ));
        };
        let uploaded = gpu.upload_resident(&frame, &grade, &drawing._peak);
        drop(held);
        let keep = window.keep;
        self.tile.replace(Some(Tiled {
            _frame: frame,
            uploaded,
            window,
            peak_nits: request.grade.peak_nits,
        }));
        Ok(format!(
            "{{\"left\":{},\"top\":{},\"width\":{},\"height\":{}}}",
            keep[0], keep[1], keep[2], keep[3],
        ))
    }

    /// Lets the held tile go, which is a glass drawing the editor's own frame again.
    #[wasm_bindgen(js_name = releaseTile)]
    pub fn release_tile(&self) {
        self.tile.replace(None);
    }

    /// The repairs a reader is offered for a loop they drew, as `crate::repair::Repair`s in JSON,
    /// cheapest seam first.
    ///
    /// `drawn` is the loop on the `px::Stored` grid and `others` the repairs the document already
    /// holds, none of which a fill may be read from under. Searched on the frame this open is
    /// drawing, which is the picture the repairs are applied to - so what the reader is offered is
    /// what the pass will draw. Where that frame is a window of a larger picture, the search looks
    /// no further than the window. `grow` lets each seam grow past the loop to hide itself; without
    /// it every seam is the loop as drawn.
    ///
    /// `without`, where given, is a repair the frame is showing at the loop, and the search reads
    /// the picture from under it while the stage goes on showing it (`RetouchedFrame::measure`).
    /// `donor`, where given, is where the reader put the fill, and the one repair answered is
    /// filled from there rather than from anywhere the search would find.
    #[wasm_bindgen(js_name = solveRepair)]
    pub async fn solve_repair(
        &self,
        drawn: &str,
        others: &str,
        grow: bool,
        without: Option<String>,
        donor: Option<String>,
    ) -> Result<String, JsValue> {
        let malformed = |what: &str, e: serde_json::Error| {
            JsValue::from_str(&format!("rawshim: this {what} is malformed: {e}"))
        };
        let drawn: Vec<[u16; 2]> = serde_json::from_str(drawn).map_err(|e| malformed("loop", e))?;
        let drawn = crate::repair::loop_of(drawn).map_err(|why| JsValue::from_str(&why))?;
        let others = repairs_of(others)?;
        let without = without.as_deref().map(repair_of).transpose()?;
        let donor = donor.as_deref().map(donor_of).transpose()?;
        // Measured under the borrow and awaited after it, since a `RefCell` may not be held across
        // an await.
        let measuring = {
            let held = self.drawing.borrow();
            let Some(drawing) = held.as_ref() else {
                return Err(JsValue::from_str(
                    "rawshim: no photograph is open to repair",
                ));
            };
            drawing
                .frame
                .measure(drawn, without.as_ref(), donor)
                .map_err(|why| JsValue::from_str(&format!("rawshim: {why}")))?
        };
        let solved = measuring
            .solved(&others, grow)
            .await
            .map_err(|why| JsValue::from_str(&format!("rawshim: {why}")))?;
        serde_json::to_string(&solved).map_err(|e| JsValue::from_str(&format!("rawshim: {e}")))
    }

    /// One strip of a re-prepare, written into the frame that is already up.
    ///
    /// **The mosaic controls are the ones that re-run the decode**, both stages living above the
    /// demosaic - and the whole photograph is seconds, so the strips arrive and the picture fills
    /// in. Copied buffer to buffer: a band is a contiguous run of rows, so it lands in the frame
    /// without going near the host.
    ///
    /// **`rows` is even, except for the band that ends the frame.** Three samples to a pixel and
    /// two samples to a word, so an odd-width frame's rows begin on alternate half-words and
    /// `copy_buffer_to_buffer` will not start on one. `top` is even because the caller cuts at a
    /// fixed even stride, and `keep_top` because `tile::grown` aligns a window to an even number
    /// of texels; this is the third of the three, and the exception is handled below.
    #[wasm_bindgen(js_name = bandInto)]
    pub async fn band_into(
        &self,
        luminance: Option<f64>,
        colour: Option<f64>,
        denoiser: &str,
        sharpen: f64,
        dust_enabled: bool,
        dust_sensitivity: f64,
        dust_intensity: f64,
        top: usize,
        rows: usize,
        frame_width: usize,
        frame_height: usize,
        repairs: &str,
    ) -> Result<(), JsValue> {
        let repairs = repairs_of(repairs)?;
        let dust = crate::dust::Settings {
            enabled: dust_enabled,
            sensitivity: dust_sensitivity,
            intensity: dust_intensity,
        };
        // Before the window is cut, since a window cannot look for itself. Costs a whole-frame read
        // on the first band after the switch is thrown, and nothing on the rest of the sweep.
        self.look_for_dust(dust).await;
        let mosaic = self.mosaic_held()?;
        let band = self.band_request(
            luminance,
            colour,
            denoiser_of(denoiser)?,
            sharpen,
            dust,
            top,
            rows,
            frame_width,
            frame_height,
            repairs,
        )?;
        let (strip, window) =
            crate::tile::prepared_on_device(crate::tile::Source::Held(mosaic), &band)
                .await
                .map_err(|e| JsValue::from_str(&format!("rawshim: {e}")))?;
        let [_, keep_top, _, keep_rows] = window.keep;
        let mut held = self.drawing.borrow_mut();
        let Some(drawing) = held.as_mut() else {
            return Ok(());
        };
        drawing.uploaded.invalidate_print_cache();
        drawing
            .frame
            .write_rows(strip, keep_top, keep_rows, top)
            .map_err(|why| JsValue::from_str(&format!("rawshim: {why}")))
    }

    /// The frame that is up drawn with `repairs` instead, when they are all that changed.
    #[wasm_bindgen(js_name = redrawRepairs)]
    pub fn redraw_repairs(&self, repairs: &str) -> Result<(), JsValue> {
        let repairs = repairs_of(repairs)?;
        let mut held = self.drawing.borrow_mut();
        let Some(drawing) = held.as_mut() else {
            return Ok(());
        };
        drawing.uploaded.invalidate_print_cache();
        drawing
            .frame
            .redraw(&repairs)
            .map_err(|why| JsValue::from_str(&format!("rawshim: {why}")))
    }

    /// Everything built *over* the frame, rebuilt because the frame underneath it has changed.
    ///
    /// **A band rewrites the buffer, and nothing that was derived from it follows.** The bands go
    /// in with `copy_buffer_to_buffer`, which touches the samples and no more - so the blur the
    /// presence sliders read, the pyramid the draw averages through and the candidates the peak is
    /// re-measured off are all still the open's, taken from pixels that are no longer there.
    ///
    /// The pyramid is the one that shows. A fit-to-window draw of a large photograph reads a mip
    /// (`gpu::draw_into` takes that arm at a ratio of two or more), so without this a Detail drag
    /// or the dust switch would land every band, finish, and leave the canvas byte-identical -
    /// the control doing nothing at all until the reader zoomed past 1:2.
    ///
    /// Once, after the last band: these are whole-frame reductions, and one built against a
    /// half-replaced frame is fitted to two denoise strengths at once.
    #[wasm_bindgen(js_name = refreshDetail)]
    pub fn refresh_detail(&self) -> Result<(), JsValue> {
        let mut held = self.drawing.borrow_mut();
        let Some(drawing) = held.as_mut() else {
            return Ok(());
        };
        let refused = || JsValue::from_str("rawshim: this browser offered no WebGPU adapter");
        let gpu = crate::gpu::device().ok_or_else(refused)?;
        let base = crate::base::device(gpu).ok_or_else(refused)?;
        let (picture_w, picture_h) = drawing.picture();
        let grade = crate::gpu::Grade {
            width: drawing.width,
            height: drawing.height,
            // The picture's, as every other grade over this frame reads it. A band sweep only
            // reaches a picture with a mosaic behind it, which is never a window - but a grade
            // here that measured the buffer instead is the one asymmetry a reader of these three
            // would have to check the reachability of to trust.
            photograph_long: crate::px::Span::measured(picture_w.max(picture_h)),
            colour: drawing.matched.as_ref().and_then(|m| m.colour.as_ref()),
            white: drawing.levels.white,
            source_level: drawing.levels.peak,
            floor: drawing.levels.floor,
            reference_nits: drawing.reference_nits,
            peak_nits: drawing.peak_nits,
            exposure: crate::light::Stops::ZERO,
            adjust: crate::gpu::Adjust::none(),
            as_shot: drawing.as_shot,
            output: crate::gpu::Output::Pq,
            geometry: crate::image::Geometry::none(),
            window: drawing.placed,
            surround_window: None,
            canvas: None,
            print_tone: crate::gpu::Tonemap::Neutral,
        };
        drawing.uploaded = drawing.frame.upload(&grade, &drawing._peak);
        // Re-collected against the pixels that are there now: the threshold the open left still
        // stands (a denoise moves the scene's top end by nothing worth re-measuring), but the
        // values behind it came off the frame this sweep replaced.
        drawing.uploaded.collect_candidates(&grade);
        if let Some(pyramid) = drawing.frame.pyramid(base) {
            drawing.pyramid = pyramid;
        }
        Ok(())
    }

    fn band_request(
        &self,
        luminance: Option<f64>,
        colour: Option<f64>,
        denoiser: crate::galosh::Denoiser,
        sharpen: f64,
        dust: crate::dust::Settings,
        top: usize,
        rows: usize,
        frame_width: usize,
        frame_height: usize,
        repairs: Vec<crate::repair::Repair>,
    ) -> Result<crate::tile::TileRequest, JsValue> {
        let levels = self
            .levels
            .get()
            .ok_or_else(|| JsValue::from_str("rawshim: this photograph has not been prepared"))?;
        Ok(self.off_the_held_mosaic(crate::tile::TileRequest {
            tile: [
                0,
                top,
                frame_width,
                rows.min(frame_height.saturating_sub(top)),
            ],
            frame: [frame_width, frame_height],
            grade: self.request.grade,
            strengths: crate::image::Strengths {
                sharpen,
                defringe: self.request.defringe,
            },
            denoise_luminance: luminance,
            denoise_colour: colour,
            denoiser,
            // The photograph's particles reach this through the analysis, as its noise and its lens
            // already do; what is here is only what the reader asked be done with them.
            dust,
            adjust: crate::gpu::Adjust::none(),
            levels: Some(levels),
            noise_fit: self.fit,
            capture_sigma: None,
            sensor_long: None,
            defocus: self
                .defocus
                .get()
                .map_or(crate::base::Defringe::Measure, crate::base::Defringe::Take),
            photo_analysis: self.analysis_bytes(),
            scale: crate::view::Scale::Full,
            repairs,
        }))
    }

    /// The one field a window cut from *this* mosaic cannot be told by the page.
    ///
    /// **The sensor's long edge above all.** `capture_sigma` is a blur in the sensor's own pixels
    /// and `image::deconvolve_split` composes it for whatever scale the target is at, so a window
    /// that took the *prepared* photograph's long edge for the sensor's sharpens a halved decode at
    /// the wrong sigma - and a loupe is where that shows, being the one place the glass and the
    /// export it predicts are compared. The page names the photograph it is cutting from, which is
    /// the halved size; the held mosaic is the sensor's, and it is on this side.
    fn off_the_held_mosaic(
        &self,
        mut request: crate::tile::TileRequest,
    ) -> crate::tile::TileRequest {
        request.sensor_long = self.held.as_ref().map(crate::decode::Held::picture_long);
        request
    }

    /// Takes a framed prepared picture as the one this open draws, replacing whatever it held.
    ///
    /// **The stage is not in it, which is the whole reason this is a method.** A reader zooming
    /// into a canvas is handed a finer window of it and has to keep drawing on the canvas the page
    /// transferred at the open - `transferControlToOffscreen` moves a backing store for good, and
    /// an element can never take a context on this thread again - so a new picture replaces
    /// `drawing` and everything else here, and leaves `stage`, the geometry and the reader's
    /// `Adjust` where they are.
    fn take_picture(&mut self, framed: &[u8]) -> Result<(), JsValue> {
        let (header, described, samples) = unframe(framed)?;
        let (width, height) = (header.width, header.height);
        // Checked, because these came off a socket and a `usize` is 32 bits here: a product that
        // wrapped would agree with a short buffer and draw whatever was behind it.
        let wanted = width
            .checked_mul(height)
            .and_then(|pixels| pixels.checked_mul(3))
            .ok_or_else(|| {
                JsValue::from_str(&format!(
                    "rawshim: a {width}x{height} picture is not a picture"
                ))
            })?;
        if samples.len() != wanted {
            return Err(JsValue::from_str(&format!(
                "rawshim: a {width}x{height} picture is {wanted} samples and {} arrived",
                samples.len(),
            )));
        }

        let levels = crate::tone::Levels {
            white: header.white,
            peak: header.peak,
            floor: header.floor,
        };
        self.mosaic = header.mosaic;
        self.fit = header.noise_fit;
        self.levels.set(Some(levels));
        // **The fitted transform rides in the analysis; the header says which part is active.** A
        // lens-only prepare keeps richer stored colour for a later full render without grading
        // this picture through it.
        self.analysis.replace(header.photo_analysis.clone());
        self.defocus.set(Some(header.defocus));
        self.header = described;
        // The tile too: a magnifier over a window that has been replaced is pointing at the
        // picture the reader was looking at a moment ago.
        self.tile.replace(None);
        // **Kept as tiles and drawn from them**, as every later window is, so there is one place
        // the reader's repairs are drawn over a picture that arrived without them.
        let level = header
            .window
            .map_or((width, height), |placed| placed.canvas);
        let origin = header.window.map_or((0, 0), |placed| placed.origin);
        self.keep_tiles(&header, &samples, &[])?;
        self.shown.set(Some((level, origin, (width, height))));
        self.assemble(level, origin, (width, height))
    }

    /// The tiles of a level a rectangle needs that this open is not holding, each as its own
    /// rectangle.
    ///
    /// **Listed rather than unioned, and the list is what makes an L cost an L.** One request
    /// covers them all, because a prepare's fixed cost is a file open and a region decode for
    /// every source it touches - but the library is told the squares as well as their box, so each
    /// source is decoded for the box bounding *its own* squares and a source no square reaches is
    /// not opened at all (`composite_tile::CompositeRequest::parts`). Handed only the box, a diagonal pan
    /// would decode every source for a corner nobody asked about.
    fn missing_over(
        &self,
        level: (usize, usize),
        at: (usize, usize),
        size: (usize, usize),
    ) -> Vec<((usize, usize), (usize, usize))> {
        let ((left, top), (right, bottom)) = tiles_over(at, size, level);
        let held = self.held_tiles.borrow();
        let mut short = Vec::new();
        for row in top..=bottom {
            for column in left..=right {
                let (tile_at, tile_size) = tile_rect(column, row, level);
                if tile_size.0 == 0 || tile_size.1 == 0 {
                    continue;
                }
                let have = held
                    .iter()
                    .any(|p| p.level == level && p.column == column && p.row == row);
                if !have {
                    short.push((tile_at, tile_size));
                }
            }
        }
        short
    }

    /// Builds the frame a tick draws from out of the tiles covering `at`, and holds it.
    ///
    /// **One buffer, not a draw per tile**, and the pyramid is why. A presence slider reads a blur
    /// of the picture, and a blur built per tile disagrees with its neighbours across every seam -
    /// so the tiles are copied into one frame and everything above this point sees exactly what it
    /// saw when a window arrived whole. The copies are device-local and a pan is a handful of them.
    fn assemble(
        &self,
        level: (usize, usize),
        at: (usize, usize),
        size: (usize, usize),
    ) -> Result<(), JsValue> {
        let refused = || JsValue::from_str("rawshim: this browser offered no WebGPU adapter");
        let gpu = crate::gpu::device().ok_or_else(refused)?;
        let ((left, top), (right, bottom)) = tiles_over(at, size, level);
        let (first, _) = tile_rect(left, top, level);
        let (last_at, last_size) = tile_rect(right, bottom, level);
        let whole = (
            last_at.0 + last_size.0 - first.0,
            last_at.1 + last_size.1 - first.1,
        );

        let frame = crate::resident::Resident::empty(gpu, whole.0, whole.1);
        let now = self.tick.get() + 1;
        self.tick.set(now);
        {
            let mut held = self.held_tiles.borrow_mut();
            let mut recording = gpu.record();
            {
                let encoder = recording.encoder();
                for patch in held.iter_mut() {
                    if patch.level != level {
                        continue;
                    }
                    if patch.column < left
                        || patch.column > right
                        || patch.row < top
                        || patch.row > bottom
                    {
                        continue;
                    }
                    patch.used = now;
                    for (from, to, bytes) in crate::resident::runs(
                        whole.0,
                        patch.at.0 - first.0,
                        patch.at.1 - first.1,
                        patch.size.0,
                        patch.size.1,
                    ) {
                        encoder.copy_buffer_to_buffer(
                            patch.rgb.buffer(),
                            from,
                            frame.buffer(),
                            to,
                            bytes,
                        );
                    }
                }
            }
            recording.submit();
        }
        let frame = crate::retouched_frame::RetouchedFrame::drawn(
            frame,
            crate::px::Size::exact(level.0, level.1),
            crate::px::At::exact(first.0, first.1),
            &self.repairs.borrow(),
        )
        .map_err(|why| JsValue::from_str(&format!("rawshim: {why}")))?;

        let levels = self.levels.get().ok_or_else(|| {
            JsValue::from_str("rawshim: no picture has been prepared for these tiles")
        })?;
        let stored = self
            .analysis
            .borrow()
            .as_deref()
            .and_then(crate::photo_analysis::decode)
            .unwrap_or_default();
        let header: crate::edit::PreparedHeader = serde_json::from_str(&self.header)
            .map_err(|e| JsValue::from_str(&format!("rawshim: this open has no header: {e}")))?;
        self.hold_drawing(crate::edit::Opened {
            frame,
            levels,
            matched: header.camera_match.apply(stored.from_raw.matched.clone()),
            as_shot: header.as_shot,
            header: crate::edit::PreparedHeader {
                width: whole.0,
                height: whole.1,
                window: Some(crate::edit::PreparedWindow {
                    canvas: level,
                    origin: first,
                }),
                ..header
            },
        })
    }

    /// Cuts a prepared rectangle into tiles and keeps them, evicting the oldest past the budget.
    ///
    /// **The reply's own header says where it landed, not the request.** The library clips a
    /// rectangle to its level and rounds it out to even columns, so a client that sliced on what
    /// it asked for would slice a pixel off the boundary and stitch two tiles from one tile's
    /// samples.
    ///
    /// A tile whose square the rectangle only partly covers is skipped rather than kept short: it
    /// would read as held and draw a band of black down the part that never arrived. The request
    /// is a union of whole tiles, so this only ever discards at the picture's own ragged edge -
    /// where `tile_rect` has already made the square short and the two agree.
    ///
    /// **And only the squares `asked` names.** The reply spans the box bounding them, so an L of
    /// squares arrives with its corner filled by whatever the sources happened to reach with the
    /// regions the L paid for - which is not the corner's own picture, and a source none of the L
    /// touched was never opened. Keeping it would hold a tile that looks resident and is partly
    /// black. Empty means the reply is the whole of what was wanted, which is what a level's own
    /// window is.
    fn keep_tiles(
        &self,
        header: &crate::edit::PreparedHeader,
        samples: &[u16],
        asked: &[((usize, usize), (usize, usize))],
    ) -> Result<(), JsValue> {
        let refused = || JsValue::from_str("rawshim: this browser offered no WebGPU adapter");
        let gpu = crate::gpu::device().ok_or_else(refused)?;
        let placed = header.window;
        let level = placed.map_or((header.width, header.height), |it| it.canvas);
        let origin = placed.map_or((0, 0), |it| it.origin);
        let whole = crate::resident::Resident::upload(gpu, samples, header.width, header.height);

        let ((left, top), (right, bottom)) =
            tiles_over(origin, (header.width, header.height), level);
        let now = self.tick.get() + 1;
        self.tick.set(now);
        let mut held = self.held_tiles.borrow_mut();
        for row in top..=bottom {
            for column in left..=right {
                let (at, size) = tile_rect(column, row, level);
                let inside = at.0 >= origin.0
                    && at.1 >= origin.1
                    && at.0 + size.0 <= origin.0 + header.width
                    && at.1 + size.1 <= origin.1 + header.height;
                if !inside || size.0 == 0 || size.1 == 0 {
                    continue;
                }
                if !asked.is_empty() && !asked.iter().any(|(want, _)| *want == at) {
                    continue;
                }
                let rgb = crate::resident::Resident::empty(gpu, size.0, size.1);
                let mut recording = gpu.record();
                {
                    let encoder = recording.encoder();
                    for (to, from, bytes) in crate::resident::runs(
                        header.width,
                        at.0 - origin.0,
                        at.1 - origin.1,
                        size.0,
                        size.1,
                    ) {
                        encoder.copy_buffer_to_buffer(
                            whole.buffer(),
                            from,
                            rgb.buffer(),
                            to,
                            bytes,
                        );
                    }
                }
                recording.submit();
                // Replaced rather than doubled: a re-prepare at new mosaic settings sends the same
                // squares again, and two of one tile is one of them never read.
                let already = held
                    .iter()
                    .position(|p| p.level == level && p.column == column && p.row == row);
                if let Some(already) = already {
                    held.remove(already).rgb.reclaim();
                }
                held.push(Patch {
                    level,
                    column,
                    row,
                    at,
                    size,
                    rgb,
                    used: now,
                });
            }
        }
        whole.reclaim();

        // The oldest first, and never a tile this reply just brought.
        let mut resident: usize = held.iter().map(Patch::bytes).sum();
        while resident > TILE_BUDGET_BYTES && held.len() > 1 {
            let oldest = held
                .iter()
                .enumerate()
                .min_by_key(|(_, patch)| patch.used)
                .map(|(at, _)| at);
            let Some(oldest) = oldest.filter(|at| held[*at].used < now) else {
                break;
            };
            resident -= held[oldest].bytes();
            held.remove(oldest).rgb.reclaim();
        }
        Ok(())
    }

    /// The mosaic this page decoded, or a refusal naming what needs one.
    ///
    /// A picture prepared elsewhere arrives coded, so everything below the coding - the denoise,
    /// the demosaic, the dust search, the loupe's own rendition chain - has nothing to run over.
    /// Said rather than silently skipped: a Detail slider that does nothing is worse than one the
    /// page does not offer, and the page decides which to offer from `mosaic`.
    fn mosaic_held(&self) -> Result<&crate::decode::Held, JsValue> {
        self.held.as_ref().ok_or_else(|| {
            JsValue::from_str(
                "rawshim: this picture was prepared elsewhere and arrived already coded, so there \
                 is no mosaic here to filter, demosaic or magnify from",
            )
        })
    }

    fn attach(
        &self,
        into: &std::cell::RefCell<Option<crate::gpu::Stage>>,
        canvas: web_sys::OffscreenCanvas,
        width: u32,
        height: u32,
    ) -> Result<(), JsValue> {
        let gpu = crate::gpu::device()
            .ok_or_else(|| JsValue::from_str("rawshim: this browser offered no WebGPU adapter"))?;
        let stage = crate::gpu::Stage::attach(gpu, canvas, width, height)
            .ok_or_else(|| JsValue::from_str("rawshim: this canvas would not take a surface"))?;
        into.replace(Some(stage));
        Ok(())
    }

    /// The backing store the reader's box asks for, which a resize or a density change moves.
    #[wasm_bindgen(js_name = resizeStage)]
    pub fn resize_stage(&self, width: u32, height: u32) {
        if let (Some(gpu), Some(stage)) = (crate::gpu::device(), self.stage.borrow_mut().as_mut()) {
            stage.resize(gpu, width, height);
        }
    }

    /// One tick: the picture at `ev` stops, over `region` of the output, onto the stage.
    ///
    /// **Nothing comes back and nothing is read back.** The uniform is written, one pass draws the
    /// swapchain's own image and it is presented, so a tick is three calls deep and never waits on
    /// the GPU - which is what lets it be a plain call rather than a promise, where every readback
    /// on this path has to be awaited.
    /// `region` absent draws the cropped picture whole, which is what a reader who has not panned
    /// is looking at - worked out here because the geometry it is cropped by is here.
    #[wasm_bindgen(js_name = tick)]
    pub fn tick(&self, ev: f64, region: Option<String>) -> Result<(), JsValue> {
        // The page's own number, entering at the boundary that knows it is stops.
        self.draw(
            &self.stage,
            crate::light::Stops::measured(ev),
            region.as_deref(),
            Reading::Frame,
            false,
            self.proof.get(),
        )
    }

    /// The same grade at the loupe's own region, onto the loupe's canvas: the rendition's own tile
    /// where one has been built for where it points, and the editor's frame until it lands.
    #[wasm_bindgen(js_name = tickLoupe)]
    pub fn tick_loupe(&self, ev: f64, region: &str) -> Result<(), JsValue> {
        let tile = self.tile.borrow();
        self.draw(
            &self.loupe,
            crate::light::Stops::measured(ev),
            Some(region),
            tile.as_ref().map_or(Reading::Frame, Reading::Tile),
            true,
            self.proof.get(),
        )
    }

    /// The picture at `region` of the output from under `repair`, among every other repair as
    /// drawn, onto `canvas`, for the page to copy out as that repair's thumbnail.
    #[wasm_bindgen(js_name = drawThumbnail)]
    pub fn draw_thumbnail(
        &self,
        canvas: web_sys::OffscreenCanvas,
        side: u32,
        ev: f64,
        region: &str,
        repair: &str,
    ) -> Result<(), JsValue> {
        let repair = repair_of(repair)?;
        self.draw_part(canvas, side, ev, region, |frame, rect| {
            frame.original_under(&repair, rect)
        })
    }

    /// The picture at `region` of the output with `option` drawn in place of `showing`, the fill
    /// the frame is drawn with at the loop, as [`HeldRaw::draw_thumbnail`] draws: what choosing
    /// `option` would show.
    #[wasm_bindgen(js_name = drawOptionThumbnail)]
    pub fn draw_option_thumbnail(
        &self,
        canvas: web_sys::OffscreenCanvas,
        side: u32,
        ev: f64,
        region: &str,
        showing: Option<String>,
        option: &str,
    ) -> Result<(), JsValue> {
        let showing = showing.as_deref().map(repair_of).transpose()?;
        let option = repair_of(option)?;
        self.draw_part(canvas, side, ev, region, |frame, rect| {
            frame.drawn_instead(showing.as_ref(), &option, rect)
        })
    }

    /// The part of the picture behind `region` that `part` copies out of the frame, graded and
    /// drawn onto `canvas`. Proofed against sRGB whatever the stage is: the copy is eight bits.
    fn draw_part(
        &self,
        canvas: web_sys::OffscreenCanvas,
        side: u32,
        ev: f64,
        region: &str,
        part: impl FnOnce(
            &crate::retouched_frame::RetouchedFrame,
            crate::px::Rect<crate::px::Drawn>,
        ) -> Result<
            (crate::resident::Resident, crate::px::At<crate::px::Drawn>),
            String,
        >,
    ) -> Result<(), JsValue> {
        let parsed: crate::gpu::Region = serde_json::from_str(region)
            .map_err(|e| JsValue::from_str(&format!("rawshim: this region is malformed: {e}")))?;
        let [x, y, wide, deep] = self.part_of(&parsed)?;
        let (under, uploaded, part) = {
            let held = self.drawing.borrow();
            let Some(drawing) = held.as_ref() else {
                return Err(JsValue::from_str("rawshim: no photograph is open to draw"));
            };
            let (pw, ph) = drawing.picture();
            let (left, top) = ((x * pw as f64).floor(), (y * ph as f64).floor());
            let rect = crate::px::Rect::exact(
                left as usize,
                top as usize,
                (((x + wide) * pw as f64).ceil() - left) as usize,
                (((y + deep) * ph as f64).ceil() - top) as usize,
            );
            let (under, at) = part(&drawing.frame, rect)
                .map_err(|why| JsValue::from_str(&format!("rawshim: {why}")))?;
            let (width, height) = under.size();
            let window = crate::gpu::Window {
                photograph: crate::px::Size::exact(pw, ph),
                origin: at,
            };
            let gpu = crate::gpu::device().ok_or_else(|| {
                JsValue::from_str("rawshim: this browser offered no WebGPU adapter")
            })?;
            // Against the peak the stage already claimed, as a loupe tile is, so the part is graded
            // as the frame it was copied from.
            let grade = drawing.at_rest(width, height, Some(window));
            let uploaded = gpu.upload_resident(&under, &grade, &drawing._peak);
            (under, uploaded, (width, height, window))
        };
        self.attach(&self.thumbnail, canvas, side, side)?;
        let (width, height, window) = part;
        let drawn = self.draw(
            &self.thumbnail,
            crate::light::Stops::measured(ev),
            Some(region),
            Reading::Part {
                uploaded: &uploaded,
                width,
                height,
                window,
            },
            false,
            crate::gpu::Output::Srgb,
        );
        drop(under);
        drawn
    }

    /// The reader's sliders, as `gpu::Adjust` JSON. Kept rather than passed per tick: a drag moves
    /// one of them and the rest have to stay where the reader put them.
    #[wasm_bindgen(js_name = setAdjust)]
    pub fn set_adjust(&self, adjust: &str) -> Result<(), JsValue> {
        let next: crate::gpu::Adjust = serde_json::from_str(adjust)
            .map_err(|e| JsValue::from_str(&format!("rawshim: this adjust is malformed: {e}")))?;
        self.adjust.set(next);
        Ok(())
    }

    /// Which rendition the reader wants the picture proofed against.
    ///
    /// **A view of the same edits, not an edit.** The grade is untouched; what moves is where the
    /// highlights roll into and which gamut the result is clipped to, which is precisely the pair
    /// that differs between this library's two renditions (`job::peak_nits`, `frame.slang`'s `fs`).
    ///
    /// `tone` is the operator an sRGB proof fits its highlights with, named as a print scene names
    /// its own; the neutral one is the rendition's. `display_hdr` false rolls every draw onto SDR
    /// white, as the viewer's does.
    #[wasm_bindgen(js_name = setProof)]
    pub fn set_proof(&self, proof: &str, tone: &str, display_hdr: bool) -> Result<(), JsValue> {
        self.display_hdr.set(display_hdr);
        self.proof_tone.set(serde_json::from_value(serde_json::Value::from(tone))
            .map_err(|e| JsValue::from_str(&format!("rawshim: no highlights are fitted by {tone}: {e}")))?);
        self.proof.set(match proof {
            "hdr" => crate::gpu::Output::Pq,
            "srgb" => crate::gpu::Output::Srgb,
            _ => {
                return Err(JsValue::from_str(&format!(
                    "rawshim: no picture is proofed against {proof}"
                )));
            }
        });
        Ok(())
    }

    #[wasm_bindgen(js_name = setPrint)]
    pub fn set_print(&self, scene: Option<String>) -> Result<(), JsValue> {
        let parsed = scene.as_deref().map(crate::print::Scene::parse).transpose()
            .map_err(|error| JsValue::from_str(&format!("rawshim: invalid print scene: {error}")))?;
        self.print.set(parsed);
        Ok(())
    }

    /// The reader's crop, straighten and turn, as `image::Geometry` JSON.
    #[wasm_bindgen(js_name = setGeometry)]
    pub fn set_geometry(&self, geometry: &str) -> Result<(), JsValue> {
        let next: crate::image::Geometry = serde_json::from_str(geometry)
            .map_err(|e| JsValue::from_str(&format!("rawshim: this geometry is malformed: {e}")))?;
        self.geometry.set(next);
        Ok(())
    }

    fn draw(
        &self,
        onto: &std::cell::RefCell<Option<crate::gpu::Stage>>,
        ev: crate::light::Stops,
        region: Option<&str>,
        reading: Reading<'_>,
        magnified: bool,
        proof: crate::gpu::Output,
    ) -> Result<(), JsValue> {
        let held = self.drawing.borrow();
        let Some(drawing) = held.as_ref() else {
            return Ok(());
        };
        let region: crate::gpu::Region = match region {
            Some(named) => serde_json::from_str(named).map_err(|e| {
                JsValue::from_str(&format!("rawshim: this region is malformed: {e}"))
            })?,
            // The cropped picture, whole: what the geometry writes rather than what the frame
            // holds, a straighten's bounding box being larger than the frame it came from - and
            // the *picture's* size, so a window of a canvas names the region the page would name
            // for the same picture rather than one the size of its own buffer.
            None => {
                let (picture_w, picture_h) = drawing.picture();
                let (width, height) =
                    crate::hdr::cropped_size(picture_w, picture_h, self.geometry.get());
                crate::gpu::Region {
                    x: 0.0,
                    y: 0.0,
                    width: width as f64,
                    height: height as f64,
                }
            }
        };
        let stage = onto.borrow();
        let Some(stage) = stage.as_ref() else {
            return Ok(());
        };
        let (canvas_w, canvas_h) = stage.size();
        let shown = crate::gpu::Canvas {
            region: (region.x, region.y, region.width, region.height),
            size: crate::px::Size::measured(canvas_w as usize, canvas_h as usize),
            // A magnifier is only ever magnified, so it reads the frame's own buffer at whatever
            // ratio rather than a level averaged for a smaller canvas. A tile or a part has no
            // levels at all: the pyramid bound beside it is the frame's.
            max_lod: match reading {
                Reading::Frame if !magnified => drawing.pyramid.levels,
                _ => 0,
            },
        };

        // The proofed target's own peak, which is the whole of what an SDR render does to the
        // grade: everything above diffuse white rolls into it rather than clipping there.
        // A display that shows nothing past SDR white is the same target: aimed higher, the compositor
        // clips what is left over per channel and moves the hue.
        let proofed = |peak_nits: crate::light::Light<crate::light::DisplayNits>| match proof {
            crate::gpu::Output::Srgb => {
                crate::light::Light::at_diffuse_white(drawing.reference_nits)
            }
            _ if !self.display_hdr.get() => crate::light::Light::at_diffuse_white(drawing.reference_nits),
            _ => peak_nits,
        };
        // Neutral anywhere else, where nothing reads it and the regional operator would build a
        // neighbourhood for nobody.
        let proofed_tone = match proof {
            crate::gpu::Output::Srgb => self.proof_tone.get(),
            _ => crate::gpu::Tonemap::Neutral,
        };

        let (uploaded, width, height, window) = match reading {
            Reading::Tile(tiled) => {
                let scene = tiled.window.scene(ev, self.adjust.get());
                let grade = crate::gpu::Grade {
                    print_tone: proofed_tone,
                    ..tiled.window.grade(&scene, proofed(tiled.peak_nits), proof).onto(shown)
                };
                crate::gpu::present(&tiled.uploaded, stage, &grade, &drawing.pyramid, None);
                return refused();
            }
            Reading::Frame => (
                &drawing.uploaded,
                drawing.width,
                drawing.height,
                drawing.placed,
            ),
            Reading::Part {
                uploaded,
                width,
                height,
                window,
            } => (uploaded, width, height, Some(window)),
        };
        let (picture_w, picture_h) = drawing.picture();
        let adjust = self.adjust.get();
        let print = if std::ptr::eq(onto, &self.stage) { self.print.get() } else { None };
        let grade = crate::gpu::Grade {
            width,
            height,
            photograph_long: crate::px::Span::measured(picture_w.max(picture_h)),
            colour: adjust.colour(drawing.matched.as_ref().and_then(|m| m.colour.as_ref())),
            white: drawing.levels.white,
            source_level: drawing.levels.peak,
            floor: drawing.levels.floor,
            reference_nits: drawing.reference_nits,
            peak_nits: proofed(drawing.peak_nits),
            exposure: ev,
            adjust,
            as_shot: drawing.as_shot,
            output: proof,
            geometry: self.geometry.get(),
            window,
            surround_window: None,
            canvas: Some(shown),
            // An sRGB proof's. A print scene's own operator reaches the draw through
            // `draw_with_print`, which overrides this for the pigment it grades.
            print_tone: proofed_tone,
        };
        // **Before the draw, and every tick.** The peak is measured *after* the exposure
        // (`peak.slang`), so it is not a property of the photograph the way the levels are: read
        // once at rest and then raised two stops, the roll-off knee sits where a frame nobody
        // exposed put it, and every highlight clips flat against it. Off the candidates the open
        // kept rather than the frame, which is what makes it a tick's worth of work. Only where the
        // match is in play, since the neutral arm reads no `peak_out` at all. A part is graded
        // against the peak the frame's last tick left, which is the same buffer.
        if grade.colour.is_some() && matches!(reading, Reading::Frame) {
            drawing.uploaded.peak_from_candidates(&grade);
        }
        crate::gpu::present(uploaded, stage, &grade, &drawing.pyramid, print.as_ref());
        refused()
    }

    /// The request this photograph was opened with, carrying whatever has been measured for it.
    ///
    /// The camera match is half a second and the noise fit a quarter of one, and neither depends on
    /// anything a slider moves - so the second prepare of a drag reuses the first one's rather than
    /// measuring the same answers again.
    fn opened_as(&self) -> crate::edit::EditRequest {
        crate::edit::EditRequest {
            photo_analysis: self.analysis_bytes(),
            ..self.request.clone()
        }
    }

    fn analysis_bytes(&self) -> Option<Vec<u8>> {
        self.analysis
            .borrow()
            .clone()
            .or_else(|| self.request.photo_analysis.clone())
    }

    /// This photograph's particles, found once and folded into the analysis every window reads.
    ///
    /// **The switch can be thrown after the open, and usually is.** A reader turns dust removal on
    /// while looking at the picture, and what runs then is a re-prepare in bands - which go through
    /// `tile::prepared_on_device` and are deliberately unable to detect anything, because a window that
    /// found its own particles would find a different set from the bands either side of it. So the
    /// looking has to happen here, on the whole held mosaic, before any of them are cut.
    ///
    /// Into the analysis rather than a field of its own: that is already what carries the noise fit
    /// and the camera match to every band and every loupe tile, and a second channel for the same
    /// kind of fact is a second thing to keep in step.
    async fn look_for_dust(&self, settings: crate::dust::Settings) {
        // `does_anything`, not the switch alone: with the switch on and Intensity at nothing, the
        // correction will not run, and a whole-frame readback for a list nobody will divide out is
        // the one cost this is written to avoid.
        if !settings.wanted(None).does_anything()
            || self.opened_as().stored().from_raw.dust.is_some()
        {
            return;
        }
        let Some(held) = self.held.as_ref() else {
            return;
        };
        let Some(spots) = held.dust().await else {
            return;
        };
        let found = crate::photo_analysis::PhotoAnalysis {
            from_raw: crate::photo_analysis::FromRaw {
                dust: Some(spots),
                ..Default::default()
            },
            ..Default::default()
        };
        let merged = found.filled_from(&self.opened_as().stored());
        self.analysis
            .replace(Some(crate::photo_analysis::encode(&merged)));
    }

    /// What this photograph has had measured, for a page that has to hand it on.
    ///
    /// **A re-prepare answers in bands, and a band carries no header** - so a page that let the
    /// reader switch dust on after the open would otherwise never learn the particles this then
    /// found, and its loupe would keep asking for tiles that correct nothing while the stage under
    /// them showed them corrected.
    #[wasm_bindgen(js_name = analysis)]
    pub fn analysis(&self) -> Option<Vec<u8>> {
        self.analysis_bytes()
    }
}
