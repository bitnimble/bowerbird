// The picture pairs on `/hdr`, built by the app's own pipeline.
//
//   bun run scripts/hdr-demo-assets.ts [slug...]
//
// One `runJob` per photograph with two targets - the SDR rendition and the HDR one -
// so what the page shows is what an import of that raw file into a library would
// produce, at the shipped defaults, rather than a demonstration graded to win. The
// only setting that is not a default is the size: the page wants 1200px, not 3840.
//
// The raw files are Play Raw submissions from discuss.pixls.us, each licensed CC
// BY-SA by its photographer. They are cached outside the repository, and only the
// renditions - about 900kB for the ten - are committed, so a checkout needs neither
// 25MB per photograph nor a built `librawshim.so` to show the page.
//
// `bun run build:native` first: this goes through the same FFI the server does.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SettingsSchema } from '../src/schemas/settings';
import { runJob, type JobTarget } from '../src/services/processing/rawshim_job';

interface Scene {
  /** Names the two files, and the page's entry for this picture. */
  slug: string;
  /** The Play Raw thread, which is where the credit and the licence live. */
  topic: number;
  /** The raw file itself, whose extension decides what LibRaw is handed. */
  url: string;
}

// The pictures on the page, in its order. Each is a case the page makes in words
// beside it, so a change here wants a look at `web/src/features/hdr/hdr_page.tsx`,
// which carries the photographer's name against the same slug.
const SCENES: Scene[] = [
  { slug: 'beach', topic: 44432, url: 'https://discuss.pixls.us/uploads/short-url/zivNIARFeoOziUpK6ySmY3mmc6w.CR3' },
  { slug: 'moon', topic: 44647, url: 'https://discuss.pixls.us/uploads/short-url/u1uWPy8jeG3YPHIIgXNkdJWQln2.CR3' },
  { slug: 'neon', topic: 55901, url: 'https://discuss.pixls.us/uploads/short-url/i8e2JTOAsd8gxry270tPLZulEQp.CR3' },
  { slug: 'sign', topic: 33920, url: 'https://discuss.pixls.us/uploads/short-url/rjK5CIORCZhxCSdO2OunEJvnb91.ARW' },
  { slug: 'leds', topic: 28404, url: 'https://discuss.pixls.us/uploads/short-url/dZt4iNgr1wbQdmNOTDaso7rYUie.CR2' },
];

/**
 * Long enough to look at, short enough to ship ten of them: the page is not a
 * pixel-peeping view, and every visitor pays for both arms of every pair.
 */
const LONG_EDGE = 1200;

const ROOT = resolve(import.meta.dir, '..');
const OUT = join(ROOT, 'web', 'public', 'hdr');
const CACHE = join(process.env.TMPDIR ?? '/tmp', 'bowerbird-hdr-raws');

/** Every rendition setting at its shipped default, so the page shows the shipped look. */
const SETTINGS = SettingsSchema.parse({});

async function original(scene: Scene): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, `${scene.slug}${scene.url.slice(scene.url.lastIndexOf('.'))}`);
  if (existsSync(path)) return path;
  console.error(`[hdr-assets] fetching ${scene.slug}`);
  const res = await fetch(scene.url, { headers: { 'user-agent': 'bowerbird/hdr-demo-assets' } });
  if (!res.ok) throw new Error(`${scene.url}: HTTP ${res.status}`);
  await Bun.write(path, await res.arrayBuffer());
  return path;
}

function outputPath(slug: string, hdr: boolean): string {
  return join(OUT, `${slug}-${hdr ? 'hdr' : 'sdr'}.avif`);
}

function target(slug: string, hdr: boolean): JobTarget {
  return {
    rendition: 'full',
    hdr,
    outputPath: outputPath(slug, hdr),
    size: LONG_EDGE,
    source: 'render',
    sdrQuantizer: SETTINGS.full_rendition_quantizer,
    hdrQuantizer: SETTINGS.hdr_crf,
    preset: SETTINGS.hdr_preset,
    stillFullChroma: SETTINGS.hdr_still_full_chroma,
    sdrFullChroma: SETTINGS.sdr_full_chroma,
  };
}

async function build(scene: Scene): Promise<void> {
  const rawFilePath = await original(scene);
  try {
    // Both targets in one job, which is also how the importer asks for them: the render
    // and the colour fit happen once and both renditions come off the same frame, so
    // nothing about the pair can differ except the dynamic range it was encoded into.
    runJob({
      rawFilePath,
      matchEmbeddedJpeg: SETTINGS.match_embedded_jpeg,
      denoiseLuma: SETTINGS.raw_denoise_luma,
      denoiseChroma: SETTINGS.raw_denoise_chroma,
      sharpen: SETTINGS.raw_sharpen,
      defringe: SETTINGS.raw_defringe,
      grade: {
        peakNits: SETTINGS.hdr_peak_nits,
        referenceWhiteNits: SETTINGS.hdr_reference_white_nits,
        whiteQuantile: SETTINGS.hdr_white_quantile,
      },
      targets: [target(scene.slug, false), target(scene.slug, true)],
    });
  } catch (failure) {
    // A job writes its targets one at a time, so a failure on the second leaves the
    // first behind - and these outputs are committed, where a half-built pair is a
    // picture the page shows against one it does not. The worker cleans up for the
    // same reason (`processing_worker.ts`).
    for (const hdr of [false, true]) await Bun.file(outputPath(scene.slug, hdr)).delete().catch(() => {});
    throw failure;
  }

  const sizes = [false, true].map((hdr) => Bun.file(outputPath(scene.slug, hdr)).size);
  console.error(`[hdr-assets] ${scene.slug}: ${(sizes[0]! / 1024).toFixed(0)}kB SDR, ${(sizes[1]! / 1024).toFixed(0)}kB HDR`);
}

const asked = process.argv.slice(2);
const wanted = asked.length === 0 ? SCENES : SCENES.filter((scene) => asked.includes(scene.slug));
if (wanted.length === 0) throw new Error(`no such scene: ${asked.join(', ')}`);
mkdirSync(OUT, { recursive: true });
for (const scene of wanted) await build(scene);
