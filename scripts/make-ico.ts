// `icons/icon.ico` from `icons/icon.png`, which `tauri-build` requires for a Windows
// build and this repo did not have.
//
// No image library: an ICO since Vista may hold a PNG verbatim, so the whole file is a
// 6-byte header, one 16-byte directory entry, and the PNG. A 256-wide image is written as
// width 0, which is how the format says 256.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const icons = join(resolve(import.meta.dir, '..'), 'src-tauri', 'icons');
const source = join(icons, 'icon.png');
if (!existsSync(source)) {
  console.error(`[make-ico] no ${source}`);
  process.exit(1);
}

const png = readFileSync(source);
// IHDR puts the dimensions at a fixed offset, and every PNG starts with one.
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);

const out = Buffer.alloc(22 + png.length);
out.writeUInt16LE(0, 0); // reserved
out.writeUInt16LE(1, 2); // 1 = icon
out.writeUInt16LE(1, 4); // one image
out.writeUInt8(width >= 256 ? 0 : width, 6);
out.writeUInt8(height >= 256 ? 0 : height, 7);
out.writeUInt8(0, 8); // palette colours: none, it is truecolour
out.writeUInt8(0, 9); // reserved
out.writeUInt16LE(1, 10); // colour planes
out.writeUInt16LE(32, 12); // bits per pixel
out.writeUInt32LE(png.length, 14);
out.writeUInt32LE(22, 18); // the PNG starts straight after this entry
png.copy(out, 22);

const target = join(icons, 'icon.ico');
writeFileSync(target, out);
console.error(`[make-ico] ${target} (${width}x${height}, ${out.length} bytes)`);
