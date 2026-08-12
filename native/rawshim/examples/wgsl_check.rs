//! Compiles the editor's denoise kernels, which nothing on this side dispatches.
//!
//! They run in the browser, so their first compile is otherwise inside an e2e run, where a
//! WGSL error arrives as "the editor failed to open" with the message three layers down.
//! This asks the same compiler the same question in a second.

const PRELUDE: &str =
    include_str!("../../../web/src/features/raw_edit/gpu/wgsl/galosh/prelude.wgsl");

macro_rules! kernels {
    ($($name:literal),* $(,)?) => {
        [$(($name, include_str!(concat!(
            "../../../web/src/features/raw_edit/gpu/wgsl/galosh/", $name, ".wgsl"
        )))),*]
    };
}

fn main() {
    // `gpu::device` installs an uncaptured-error handler that panics, so a bad kernel
    // arrives here as the compiler's own message rather than as a silent no-op.
    let gpu = rawshim::gpu::device().expect("an adapter");

    let sources = kernels![
        "yuv_split",
        "yuv_gat_fwd",
        "yuv_sigma_scale",
        "yuv_makitalo",
        "yuv_loess",
        "yuv_join",
    ];
    for (name, body) in sources {
        let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(name),
            source: wgpu::ShaderSource::Wgsl(format!("{PRELUDE}\n{body}").into()),
        });
        std::mem::drop(module);
        println!("{name}: parsed");
    }
    println!("all parsed");
}
