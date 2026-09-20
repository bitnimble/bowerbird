// Says which adapter the grade will run on, once, at startup.
//
// **Because the failure this catches is silent.** The image carries SwiftShader, so a
// container that cannot reach the host's card still renders - on a CPU rasteriser,
// correctly, at a fraction of the speed - and nothing anywhere says so. A missing
// `devices:` or `group_add:` in the compose file looks exactly like a machine with no
// GPU. This is the line that tells them apart, before a library is imported rather
// than after the thumbnails take all night.
//
// Its own short-lived process, like `verify_shim.ts` beside it: building a wgpu device
// is adapter enumeration and shader compilation, and the app will do its own when the
// first job arrives. Nothing here is shared with it.
//
// Never fatal. This reports; it does not gate. A build with no Vulkan driver at all is
// the one case that really cannot render, and `job::run` says so per job with an error
// naming what to install.
import { dlopen, FFIType } from 'bun:ffi';

const path = process.argv[2];
if (path == null) {
  console.error('usage: report_gpu.ts <path to a librawshim .so>');
  process.exit(2);
}

try {
  const { symbols } = dlopen(path, {
    bb_gpu_adapter: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
  });
  const buffer = new Uint8Array(256);
  const length = Number(symbols.bb_gpu_adapter(buffer, BigInt(buffer.length)));
  if (length < 0) {
    console.log(
      'gpu: no Vulkan adapter answered, so no rendition will build. ' +
        'Install a driver - mesa-vulkan-drivers covers AMD and Intel, and a machine with no ' +
        'GPU wants SwiftShader',
    );
  } else if (length > buffer.length) {
    // The name is longer than anything an adapter is called; report rather than retry.
    console.log('gpu: an adapter answered with a name too long to read');
  } else {
    const name = new TextDecoder().decode(buffer.subarray(0, length));
    console.log(`gpu: ${name}`);
    // Named rather than inferred: `Cpu` is what wgpu calls SwiftShader, and on a host with
    // a card it means the render node is not reaching this container.
    if (name.includes('Cpu')) {
      console.log(
        'gpu: that is a CPU rasteriser. If this host has a GPU, the container is not ' +
          'reaching it - check `devices: /dev/dri` and `group_add` in the compose file',
      );
    }
  }
} catch (error) {
  console.log(`gpu: could not be asked: ${String(error)}`);
}
