// Writes one AVIF, so a container can prove it has an AV1 *encoder* and not just a
// decoder. Debian ships libheif's codecs as separate plugin packages and libvips
// pulls in only the decoders, so an image missing libheif-plugin-aomenc reads AVIF
// perfectly and cannot write one - which is every rendition this app produces.
//
//   bun native/smoke_avif.ts /tmp/out.avif
import { freeImage, imageFromRgb, saveAvif } from '../src/services/processing/rawshim_ops';

const out = process.argv[2] ?? '/tmp/bowerbird-smoke.avif';
const size = 64;

const image = imageFromRgb(Buffer.alloc(size * size * 3, 128), size, size);
try {
  saveAvif(image, 0, 80, 0, out);
} finally {
  freeImage(image);
}

const bytes = Bun.file(out).size;
if (bytes < 64) throw new Error(`${out} is ${bytes} bytes; the encoder wrote nothing usable`);
console.log(`wrote ${out}, ${bytes} bytes`);
