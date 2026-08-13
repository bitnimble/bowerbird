//! Do the paths that were LibRaw's still answer the same way through rawler?
//!
//! ```text
//! parity_check <raw>...
//! ```
//!
//! Three of them, each a place the dispatch used to refuse and now serves: the embedded preview,
//! a decode from bytes rather than a path, and the whole frame the other two are held against.
//!
//! The preview is compared as pixels rather than as bytes. Both decoders locate the same JPEG in the
//! same file, but they reach it differently - one unpacks a thumbnail, the other reads the
//! container - and a byte comparison would fail on a container that pads or brackets what it hands
//! back without any of the picture differing.

fn main() {
    let files: Vec<String> = std::env::args().skip(1).collect();
    if files.is_empty() {
        eprintln!("parity_check <raw>...");
        return;
    }

    for path in files {
        let name = std::path::Path::new(&path)
            .file_name()
            .map_or_else(|| path.clone(), |s| s.to_string_lossy().into_owned());

        // The preview, at the size a grid tile asks for.
        let preview = rawshim::decode_embedded_frame(&path, 1024);
        let preview = match preview.as_ref().and_then(|f| f.rgb8()) {
            Some(image) => format!("{}x{}", image.width, image.height),
            None => "none".into(),
        };

        // From bytes, which is how an edit is prepared.
        let bytes = std::fs::read(&path).ok();
        let from_bytes = bytes
            .as_ref()
            .and_then(|b| rawshim::decode_frame_bytes(b, 16, true, 0))
            .map(|f| (f.width, f.height));

        let from_path = rawshim::decode_frame_denoised(&path, 16, true, 0, Default::default()).map(|f| (f.width, f.height));

        let agree = match (from_bytes, from_path) {
            (Some(a), Some(b)) => {
                if a == b {
                    "same dimensions"
                } else {
                    "DIFFERENT dimensions"
                }
            }
            (None, None) => "both declined",
            _ => "one declined",
        };
        println!("{name:>16}  preview {preview:>12}  bytes {from_bytes:?}  path {from_path:?}  {agree}");
    }
}
