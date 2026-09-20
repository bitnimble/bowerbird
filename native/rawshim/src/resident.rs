//! A frame in VRAM, carried between stages instead of the samples behind it.
//!
//! **The pipeline's currency, and the reason it stops touching the host.** Every stage that
//! produces a picture is a shader, so a `Vec<u16>` between two of them is a frame taken off the
//! device and put straight back - 366MB each way at 61MP, for arithmetic that never wanted to
//! leave. A stage that takes and returns one of these leaves the frame where it already is, and a
//! readback appears only where a *host* stage genuinely reads: the camera match, the levels
//! quantile, the encoder.

/// One frame's samples, on the device, two to a word.
///
/// The dimensions travel with the buffer because every stage below needs them and a buffer that
/// carries its own cannot be handed to a pass sized for a different frame.
pub struct Resident {
    gpu: &'static crate::gpu::Gpu,
    buffer: crate::gpu::Buffer,
    pub width: usize,
    pub height: usize,
}

/// Six bytes, which is three samples, which is one pixel of every frame this holds.
pub const BYTES_PER_PIXEL: usize = 6;

/// The byte runs that copy a `wide` by `deep` rectangle at `left`, `top` in and out of a buffer
/// whose rows are `width` pixels: `(tight offset, strided offset, length)` each.
///
/// **A rectangle is contiguous in neither buffer unless it spans the full width**, so a copy is a
/// run per row - and one run where it does span, because a whole-width rectangle is contiguous in
/// both and a row at a time would be `deep` submissions for no reason.
///
/// Shared because two callers assemble the same way and a disagreement between them is a picture
/// with its rows sheared: a composite copies each rendered tile into the canvas
/// (`composite_job::base`), and the editor copies each held tile into the frame it draws
/// (`wasm::HeldRaw`).
pub fn runs(
    width: usize,
    left: usize,
    top: usize,
    wide: usize,
    deep: usize,
) -> Vec<(u64, u64, u64)> {
    let at = |x: usize, y: usize| ((y * width + x) * BYTES_PER_PIXEL) as u64;
    if wide == width {
        return vec![(0, at(0, top), (wide * deep * BYTES_PER_PIXEL) as u64)];
    }
    (0..deep)
        .map(|row| {
            (
                (row * wide * BYTES_PER_PIXEL) as u64,
                at(left, top + row),
                (wide * BYTES_PER_PIXEL) as u64,
            )
        })
        .collect()
}

/// A mapped readback as the samples it holds, which on these targets is the same bytes.
///
/// **A frame is hundreds of megabytes, so this is a reinterpret rather than a conversion.** At
/// 61MP a `max` rendition would otherwise walk 183 million samples one `u16::from_le_bytes` at a
/// time, on one thread, twice - once off the graded frame and once off the decode the camera
/// match reads.
#[cfg(target_endian = "little")]
pub fn samples_of(mapped: &[u8]) -> &[u16] {
    bytemuck::cast_slice(mapped)
}

/// The same the other way, for the staging copy an upload writes through.
#[cfg(target_endian = "little")]
fn as_bytes(samples: &[u16]) -> &[u8] {
    bytemuck::cast_slice(samples)
}

/// How many samples cross in one `write_buffer`.
///
/// A block at a time, for the reason `galosh` and `demosaic` give: the staged copy would otherwise
/// be a second whole frame, and at 61MP that is 361MB beside one that is already the largest thing
/// in the process.
const CHUNK: usize = 1 << 18;

impl Resident {
    /// Room for a frame, with nothing in it yet, for a pass that writes every word.
    ///
    /// `COPY_DST` as well as `COPY_SRC`, so one buffer serves a gather's destination and an
    /// upload's: distinguishing them buys a usage flag and costs a second type that every stage
    /// would have to be generic over.
    pub fn empty(gpu: &'static crate::gpu::Gpu, width: usize, height: usize) -> Resident {
        let words = (width * height * 3).div_ceil(2);
        let buffer = gpu.own_buffer(&wgpu::BufferDescriptor {
            label: Some("frame"),
            size: ((words * 4).max(4)) as u64,
            usage: wgpu::BufferUsages::STORAGE
                | wgpu::BufferUsages::COPY_SRC
                | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Resident {
            gpu,
            buffer,
            width,
            height,
        }
    }

    /// A frame the host is holding, put where the shaders can reach it.
    ///
    /// The entry to the resident half. Every stage after this one takes a `Resident`, so a
    /// pipeline uploads here and nowhere else.
    pub fn upload(
        gpu: &'static crate::gpu::Gpu,
        samples: &[u16],
        width: usize,
        height: usize,
    ) -> Resident {
        let frame = Resident::empty(gpu, width, height);
        let mut bytes: Vec<u8> = Vec::with_capacity(CHUNK * 2 + 2);
        for (at, block) in samples.chunks(CHUNK).enumerate() {
            bytes.clear();
            bytes.extend_from_slice(as_bytes(block));
            // The tail of an odd frame, so the copy covers whole words and the spare half is a
            // defined zero rather than whatever the allocation held.
            if bytes.len() % 4 != 0 {
                bytes.extend_from_slice(&[0, 0]);
            }
            gpu.queue
                .write_buffer(&frame.buffer, (at * CHUNK * 2) as u64, &bytes);
        }
        frame
    }

    pub fn gpu(&self) -> &'static crate::gpu::Gpu {
        self.gpu
    }

    /// The buffer itself, for a pass being recorded against it.
    pub fn buffer(&self) -> &crate::gpu::Buffer {
        &self.buffer
    }

    pub fn size(&self) -> (usize, usize) {
        (self.width, self.height)
    }

    pub fn samples(&self) -> usize {
        self.width * self.height * 3
    }

    pub fn words(&self) -> usize {
        self.samples().div_ceil(2)
    }

    /// A second frame holding what this one holds, on the device.
    ///
    /// For the caller that must hand out an owned frame while keeping its own - a downscale
    /// asked for the size it already is. The copy never touches the host.
    pub fn duplicate(&self) -> Resident {
        let copy = Resident::empty(self.gpu, self.width, self.height);
        let mut recording = self.gpu.record();
        recording.encoder().copy_buffer_to_buffer(
            &self.buffer,
            0,
            &copy.buffer,
            0,
            (self.words() * 4) as u64,
        );
        recording.submit();
        copy
    }

    /// The samples on the host, with the frame left where it is.
    ///
    /// **One transfer, not two.** A host stage that reads the frame does not consume it, and the
    /// stages after it are still shaders. Copying rather than taking is what lets a reader see a
    /// frame that the coding then runs over in place.
    pub async fn host(&self) -> Option<Vec<u16>> {
        let mut samples = vec![0u16; self.samples()];
        self.read_into(&mut self.gpu.record(), &mut samples).await?;
        Some(samples)
    }

    /// The same, for the last reader, which does not want the frame afterwards.
    pub async fn into_host(self) -> Option<Vec<u16>> {
        let samples = self.host().await;
        self.reclaim();
        samples
    }

    /// Submits `recording` and copies the frame back over `samples`.
    ///
    /// Takes the recording rather than making one so a stage's own passes are submitted with the
    /// copy that reads their result, which is one submit instead of two.
    pub async fn read_into(
        &self,
        recording: &mut crate::gpu::Recording<'_>,
        samples: &mut [u16],
    ) -> Option<()> {
        let bytes = (self.words() * 4) as u64;
        let readback = recording.buffer(&wgpu::BufferDescriptor {
            label: Some("frame readback"),
            size: bytes,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        recording
            .encoder()
            .copy_buffer_to_buffer(&self.buffer, 0, &readback, 0, bytes);
        recording.submit();

        crate::gpu::read_back(self.gpu, &readback, |mapped| {
            samples.copy_from_slice(&samples_of(mapped)[..samples.len()]);
        })
        .await
    }

    /// Hands the frame back at the earliest point the driver can take it.
    ///
    /// **Says the frame is finished with; does not wait for it to go.** `destroy` on a buffer whose
    /// last submission is still in flight only schedules the release against that submission, and
    /// `PollType::Poll` checks once without blocking - so a reclaim straight after a submit retires
    /// nothing, and the memory comes back at whatever poll follows. [`crate::gpu::finished`] is the
    /// spelling that waits, and costs a stall to do it.
    ///
    /// About *when*, not whether: the last handle releases it either way.
    pub fn reclaim(self) {
        let gpu = self.gpu;
        drop(self);
        gpu.nudge();
    }
}
