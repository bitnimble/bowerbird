import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../errors';
import { dustSettings } from '../../schemas/dust_settings';
import { adjustOf } from '../../schemas/edit_adjust';
import { neutralEdits } from '../../schemas/photo_edits';
import { PathSegment, route } from '../../schemas/route';
import { originalPathOf } from '../../utils/paths';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import type { PhotoReadService } from '../../services/photos/listing/photo_read_service';
import type { PhotoRenditionService } from '../../services/photos/renditions/photo_rendition_service';
import { encoderQuality } from '../../services/processing/analysis/quality';
import { runJob } from '../../services/processing/rawshim/rawshim_job';
import { AS_METERED } from '../../services/processing/pipeline/developed';
import { AVIF_EFFORT } from '../../services/processing/renditions/renditions';
import type { SettingsRepository } from '../../services/settings/settings_repository';

// Which quantizer to ship renditions at. A diagnostic, like the HDR check
// (§10.7): the trade is speed against artefacts, and only an eye at 1:1 settles
// where it stops mattering. Effort is pinned at 0 because that is where the
// speed is - 0.59s against 13.6s at the encoder's default on a 3840px frame - so
// quality is the only variable left.
//
// **Perceived quality, 0-100 and higher is better**, spanning the shipping default of 80 -
// the same numbers `full_rendition_quality` takes, so what this page shows is what setting
// that value produces. It sweeps the setting rather than the encoder's own parameter for
// exactly the reason its own history warns about: a page comparing numbers the settings no
// longer speak in is a picture of something nobody ships.
const QUALITIES = [88, 80, 70, 55] as const;

// Rebuilt per server run rather than cached in the library: this answers a
// question once and should not leave files behind for the orphan sweep.
const CACHE = path.join(tmpdir(), 'bowerbird-quality-check');

export class QualityCheckApi {
  readonly routes: Hono;

  constructor(
    private readonly photoRead: PhotoReadService,
    private readonly photoRenditions: PhotoRenditionService,
    private readonly libraries: LibrariesService,
    private readonly settings: SettingsRepository,
  ) {
    const app = new Hono();

    app.get(route(), (c) => c.html(page(this.firstPhotoId())));
    // Through the catalogue, not straight from the URL: the id is interpolated
    // into the page's markup and script, so reflecting the parameter verbatim
    // would be reflected XSS. What gets rendered is the id the database holds,
    // and an unknown one is a 404 rather than a page that fails on every image.
    app.get(route(PathSegment.param('photoId')), (c) => c.html(page(this.photoRenditions.locate(c.req.param('photoId') ?? '').photo.id)));

    app.get(route(PathSegment.img(), PathSegment.param('photoId'), PathSegment.param('quality')), async (c) => {
      const quality = Number(c.req.param('quality'));
      if (!QUALITIES.includes(quality as (typeof QUALITIES)[number])) {
        throw new AppError('NOT_FOUND', `not one of the compared qualities: ${quality}`);
      }
      // Resolved before it reaches a path, for the same reason as above: the id
      // names a cache file, and a `..` in the parameter would name someone
      // else's.
      const { photo, library } = this.photoRenditions.locate(c.req.param('photoId') ?? '');

      // This page decodes a RAW to compare encoder settings, so a row composed out of several
      // of them is not something it can be pointed at.
      const rawFilePath = originalPathOf(library, photo);
      if (rawFilePath == null) throw new AppError('VALIDATION_ERROR', `${photo.id} has no file to decode`);

      const file = path.join(CACHE, `${photo.id}-${quality}.avif`);
      let encodeMs = 0;

      if (!(await Bun.file(file).exists())) {
        // Created here rather than once at startup: this lives in the temp
        // directory, which something else is entitled to clean at any time.
        mkdirSync(CACHE, { recursive: true });
        // One rendition job with one target, which is what this page always was:
        // decode the RAW and write a viewer-sized AVIF at the quality being
        // compared. Going through the same call the import does is also what keeps
        // the page honest - a setting that changed the renditions and not this
        // would make it a picture of something nobody ships.
        const settings = this.settings.get();
        const started = Bun.nanoseconds();
        runJob({
          rawFilePath,
          matchEmbeddedJpeg: settings.match_embedded_jpeg,
          // The photograph's own, which is the document's default: this page compares
          // quantizers against what the library actually ships, and a denoise named here
          // would be a strength no rendition of this photograph is ever taken at.
          denoiseLuminance: null,
          denoiseColour: null,
          denoiser: AS_METERED.denoiser,
          // Off, for the same reason: this page compares quantizers, and a correction that
          // removed a few discs from whichever photograph was chosen is a second variable.
          dust: dustSettings(undefined),
          sharpen: AS_METERED.sharpen,
          defringe: settings.raw_defringe,
          // The scene as metered, deliberately. This page compares encoder settings
          // against each other, so a photographer's own exposure on whichever photo
          // happens to be chosen would be a variable in a measurement that is about
          // quantizers.
          exposure: 0,
          adjust: adjustOf(neutralEdits()),
          geometry: { crop: [0, 0, 1, 1], angleDegrees: 0, rotate: 0, keystone: null },
          grade: {
            peakNits: settings.hdr_peak_nits,
            referenceWhiteNits: settings.hdr_reference_white_nits,
            whiteQuantile: settings.hdr_white_quantile,
          },
          targets: [
            {
              rendition: 'full',
              output: 'srgb',
              outputPath: file,
              size: settings.full_rendition_size,
              source: 'render',
              sdrQuantizer: encoderQuality('avif-sdr', quality),
              hdrQuantizer: encoderQuality('avif-hdr', quality),
              preset: settings.hdr_preset,
              stillFullChroma: settings.hdr_still_full_chroma,
              sdrFullChroma: settings.sdr_full_chroma,
            },
          ],
        });
        // The decode is inside the timing now, where it was excluded before. It is
        // the same work at every quality, so it shifts each number by the same
        // constant and the comparison the page exists for is unchanged.
        encodeMs = Math.round((Bun.nanoseconds() - started) / 1e6);
      }

      const out = Bun.file(file);
      return new Response(out, {
        headers: {
          'Content-Type': 'image/avif',
          // Read by the page for the caption; 0 means it was already built, so
          // the number shown is always a real encode rather than a cache hit.
          'X-Encode-Ms': String(encodeMs),
          'Cache-Control': 'no-store',
        },
      });
    });

    this.routes = app;
  }

  private firstPhotoId(): string {
    for (const library of this.libraries.list()) {
      const first = this.photoRead.listByLibrary(library.id, { offset: 0, limit: 1, include_deleted: false }).photos[0];
      if (first != null) return first.id;
    }
    throw new AppError('NOT_FOUND', 'no photos catalogued yet');
  }
}

function page(photoId: string): string {
  const cells = QUALITIES.map(
    (q) => `
      <figure>
        <figcaption>q${q} <span data-size="${q}">…</span></figcaption>
        <div class="crop"><img data-q="${q}" alt="quality ${q}"></div>
      </figure>`,
  ).join('');

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AVIF quality check</title>
<style>
  :root { color-scheme: dark; }
  body { background: #111; color: #999; font: 13px/1.4 system-ui, sans-serif; margin: 0; padding: 12px; }
  h1 { font-size: 16px; margin: 0 0 4px; color: #ddd; }
  .row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  figure { margin: 0; min-width: 0; }
  figcaption { padding: 3px 0; color: #ddd; }
  /* 1:1 pixels, not a scaled-down view. Compression artefacts are invisible
     downscaled, which is the only way this comparison is worth making. */
  .crop { height: 60vh; overflow: hidden; background: #000; }
  .crop img { width: 100%; height: 100%; object-fit: none; object-position: var(--pos, 50% 50%); }
  code { color: #7fd; }
  label { color: #ddd; }
</style>
<h1>AVIF quality, effort ${AVIF_EFFORT}, at the full rendition size</h1>
<p>
  Shown at <strong>1:1</strong>, not scaled: artefacts vanish in a downscaled view.
  Drag any panel to pan them all. <code id="note"></code>
</p>
<p>
  <label>Pan: <input id="pan" type="range" min="0" max="100" value="50"></label>
  <label>Vertical: <input id="tilt" type="range" min="0" max="100" value="50"></label>
</p>
<div class="row">${cells}</div>
<script>
  const note = document.getElementById('note');
  let pending = ${QUALITIES.length};

  for (const img of document.querySelectorAll('[data-q]')) {
    const q = img.dataset.q;
    fetch('${route(PathSegment.qualityCheck(), PathSegment.img(), photoId)}/' + q)
      .then(async (r) => {
        if (!r.ok) throw new Error('build failed: ' + r.status);
        const ms = r.headers.get('X-Encode-Ms');
        const blob = await r.blob();
        img.src = URL.createObjectURL(blob);
        const kb = (blob.size / 1024).toFixed(0);
        document.querySelector('[data-size="' + q + '"]').textContent =
          kb + ' kB' + (ms && ms !== '0' ? '  ·  ' + ms + 'ms' : '');
        if (--pending === 0) note.textContent = 'all four built';
      })
      .catch((e) => { note.textContent = String(e); });
  }

  // One position for every panel, so the same pixels are being compared.
  function apply() {
    const x = document.getElementById('pan').value;
    const y = document.getElementById('tilt').value;
    for (const c of document.querySelectorAll('.crop img')) c.style.setProperty('--pos', x + '% ' + y + '%');
  }
  for (const id of ['pan', 'tilt']) document.getElementById(id).addEventListener('input', apply);
</script>`;
}
