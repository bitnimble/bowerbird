// The app icons, drawn from the same mark the page uses as its favicon.
//
// `web/index.html` carries that mark inline as an SVG data URI - the bower: three
// collected objects, arranged by colour - and this draws the same rectangles into the
// raster formats a desktop build wants, and the Android launcher icon. Kept as code rather than as checked-in artwork so
// the two cannot drift, and because the mark is four rectangles.
//
// No image library: a PNG is a zlib stream of filtered scanlines with a CRC per chunk, and
// an ICO since Vista may hold a PNG verbatim. Both are short enough to write out.
//
//   bun run scripts/make-icons.ts
//
// Every build script calls `ensureIcons` first, because `tauri-build` reads `icon.ico`
// while cargo compiles and a fresh clone has none - the outputs are gitignored.
import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The favicon's viewBox, so the coordinates below are the ones in `web/index.html`. */
const UNITS = 32;
const SIZE = 512;

type Rect = { x: number; y: number; w: number; h: number; fill: [number, number, number] };

const BACKGROUND: [number, number, number] = [0x0b, 0x0d, 0x11];
const BARS: Rect[] = [
  { x: 5, y: 9, w: 22, h: 4, fill: [0x4c, 0x7d, 0xf0] },
  { x: 5, y: 16, w: 11, h: 4, fill: [0x7f, 0xd4, 0xe8] },
  { x: 5, y: 23, w: 17, h: 4, fill: [0x23, 0x28, 0x33] },
];

/**
 * `tile` is the whole mark on a rounded square. `foreground` is an Android adaptive icon's top
 * layer: the bars alone on a 108dp canvas, inside the 66dp circle every launcher mask keeps.
 */
type Layer = 'tile' | 'foreground';

/** Mark units across an adaptive foreground's 108dp, keeping the bars inside its safe circle. */
const FOREGROUND_UNITS = 32 * (108 / 60);

/** RGBA, so the corners can be rounded away rather than left square on a dock. */
function draw(size: number, layer: Layer = 'tile'): Uint8Array {
  const pixels = new Uint8Array(size * size * 4);
  // A squircle-ish radius: enough that macOS and Windows both read it as an app tile
  // rather than as a photograph.
  const radius = size * 0.18;
  const inTile = (x: number, y: number): boolean => {
    const dx = Math.max(radius - x, x - (size - radius), 0);
    const dy = Math.max(radius - y, y - (size - radius), 0);
    return dx * dx + dy * dy <= radius * radius;
  };
  const scale = size / (layer === 'tile' ? UNITS : FOREGROUND_UNITS);
  const offset = size / 2 - (UNITS / 2) * scale;
  const colourAt = (x: number, y: number): [number, number, number] | null => {
    if (layer === 'tile' && !inTile(x, y)) return null;
    const ux = (x - offset) / scale;
    const uy = (y - offset) / scale;
    const bar = BARS.findLast((b) => ux >= b.x && ux < b.x + b.w && uy >= b.y && uy < b.y + b.h);
    return bar?.fill ?? (layer === 'tile' ? BACKGROUND : null);
  };

  // Four by four samples a pixel, since the launcher sizes put bar edges mid-pixel.
  const SAMPLES = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sum: [number, number, number, number] = [0, 0, 0, 0];
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const colour = colourAt(x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES);
          if (colour == null) continue;
          sum[0] += colour[0];
          sum[1] += colour[1];
          sum[2] += colour[2];
          sum[3] += 1;
        }
      }
      const covered = sum[3];
      if (covered === 0) continue;
      const at = (y * size + x) * 4;
      pixels[at] = Math.round(sum[0] / covered);
      pixels[at + 1] = Math.round(sum[1] / covered);
      pixels[at + 2] = Math.round(sum[2] / covered);
      pixels[at + 3] = Math.round((255 * covered) / (SAMPLES * SAMPLES));
    }
  }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(body).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function png(pixels: Uint8Array, size = SIZE): Buffer {
  // Filter byte 0 (none) per scanline, which is what the zlib stream expects in front of
  // each row. The mark is flat colour, so a smarter filter would buy nothing.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.subarray(y * size * 4, (y + 1) * size * 4)).copy(
      raw,
      y * (size * 4 + 1) + 1,
    );
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 512-wide image is written as width 0, which is how the format spells 256-or-more. */
function ico(embedded: Buffer): Buffer {
  const out = Buffer.alloc(22 + embedded.length);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(1, 4);
  out[6] = SIZE >= 256 ? 0 : SIZE;
  out[7] = SIZE >= 256 ? 0 : SIZE;
  out.writeUInt16LE(1, 10);
  out.writeUInt16LE(32, 12);
  out.writeUInt32LE(embedded.length, 14);
  out.writeUInt32LE(22, 18);
  embedded.copy(out, 22);
  return out;
}

/**
 * One `ic09` entry, which is the 512x512 slot and takes a PNG payload directly.
 *
 * macOS scales what it is given for the smaller slots, so a single entry at this size is a
 * complete icon rather than a partial one - and the mark is rectangles, which survive it.
 */
function icns(embedded: Buffer): Buffer {
  const entry = Buffer.alloc(8 + embedded.length);
  entry.write('ic09', 0, 'ascii');
  entry.writeUInt32BE(entry.length, 4);
  embedded.copy(entry, 8);

  const out = Buffer.alloc(8 + entry.length);
  out.write('icns', 0, 'ascii');
  out.writeUInt32BE(out.length, 4);
  entry.copy(out, 8);
  return out;
}

const ICONS = join(resolve(import.meta.dir, '..'), 'src-tauri', 'icons');

/** Draws all three, for a build script to call before it reaches for cargo. */
export function ensureIcons(): void {
  if (['icon.png', 'icon.ico', 'icon.icns'].every((f) => existsSync(join(ICONS, f)))) return;
  writeDesktopIcons();
}

function writeDesktopIcons(): void {
  mkdirSync(ICONS, { recursive: true });
  const image = png(draw(SIZE));
  writeFileSync(join(ICONS, 'icon.png'), image);
  writeFileSync(join(ICONS, 'icon.ico'), ico(image));
  writeFileSync(join(ICONS, 'icon.icns'), icns(image));
  console.error(`[make-icons] ${SIZE}x${SIZE} icon.png, icon.ico and icon.icns in ${ICONS}`);
}

/** Launcher icon density buckets, as multiples of a 1dp pixel. */
const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/**
 * Replaces the launcher icon in a generated Android project's `res`: the tile at 48dp for
 * Android 7, and an adaptive icon of the bars over the mark's background for every later one.
 */
export function writeAndroidIcons(res: string): void {
  for (const [density, scale] of Object.entries(DENSITIES)) {
    const mipmap = join(res, `mipmap-${density}`);
    mkdirSync(mipmap, { recursive: true });
    const tile = 48 * scale;
    const foreground = 108 * scale;
    writeFileSync(join(mipmap, 'ic_launcher.png'), png(draw(tile), tile));
    writeFileSync(
      join(mipmap, 'ic_launcher_foreground.png'),
      png(draw(foreground, 'foreground'), foreground),
    );
  }
  const adaptive = join(res, 'mipmap-anydpi-v26');
  mkdirSync(adaptive, { recursive: true });
  writeFileSync(
    join(adaptive, 'ic_launcher.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <background android:drawable="@color/bowerbird_icon_background" />',
      '    <foreground android:drawable="@mipmap/ic_launcher_foreground" />',
      '</adaptive-icon>',
      '',
    ].join('\n'),
  );
  const hex = BACKGROUND.map((c) => c.toString(16).padStart(2, '0')).join('');
  mkdirSync(join(res, 'values'), { recursive: true });
  writeFileSync(
    join(res, 'values', 'bowerbird_icon.xml'),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<resources>',
      `    <color name="bowerbird_icon_background">#${hex}</color>`,
      '</resources>',
      '',
    ].join('\n'),
  );
}

// Run directly, always redraw; imported, only fill in what is missing.
if (import.meta.main) {
  writeDesktopIcons();
}
