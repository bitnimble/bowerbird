import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { AppError } from '../../errors';
import { getOriginalPath } from '../../utils/paths';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import type { PhotosService } from '../../services/photos/photos_service';
import { decodeRawImage, freeImage, saveAvif } from '../../services/processing/rawshim_ops';
import { AVIF_EFFORT } from '../../services/processing/renditions';
import type { SettingsRepository } from '../../services/settings/settings_repository';

// Which AVIF quality to ship renditions at. A diagnostic, like the HDR check
// (§10.7): the trade is speed against artefacts, and only an eye at 1:1 settles
// where it stops mattering. Effort is pinned at 0 because that is where the
// speed is - 0.59s against 13.6s at the encoder's default on a 3840px frame - so
// quality is the only variable left.
const QUALITIES = [60, 70, 80, 85] as const;

// Rebuilt per server run rather than cached in the library: this answers a
// question once and should not leave files behind for the orphan sweep.
const CACHE = path.join(tmpdir(), 'bowerbird-quality-check');

export class QualityCheckApi {
  readonly routes: Hono;

  constructor(
    private readonly photos: PhotosService,
    private readonly libraries: LibrariesService,
    private readonly settings: SettingsRepository,
  ) {
    const app = new Hono();

    app.get('/', (c) => c.html(page(this.firstPhotoId())));
    // Through the catalogue, not straight from the URL: the id is interpolated
    // into the page's markup and script, so reflecting the parameter verbatim
    // would be reflected XSS. What gets rendered is the id the database holds,
    // and an unknown one is a 404 rather than a page that fails on every image.
    app.get('/:photoId', (c) => c.html(page(this.photos.locate(c.req.param('photoId') ?? '').photo.id)));

    app.get('/img/:photoId/:quality', async (c) => {
      const quality = Number(c.req.param('quality'));
      if (!QUALITIES.includes(quality as (typeof QUALITIES)[number])) {
        throw new AppError('NOT_FOUND', `not one of the compared qualities: ${quality}`);
      }
      // Resolved before it reaches a path, for the same reason as above: the id
      // names a cache file, and a `..` in the parameter would name someone
      // else's.
      const { photo, library } = this.photos.locate(c.req.param('photoId') ?? '');

      const file = path.join(CACHE, `${photo.id}-${quality}.avif`);
      let encodeMs = 0;

      if (!(await Bun.file(file).exists())) {
        // Created here rather than once at startup: this lives in the temp
        // directory, which something else is entitled to clean at any time.
        mkdirSync(CACHE, { recursive: true });
        const image = decodeRawImage(getOriginalPath(library, photo.file_path), 8, 'srgb', 0);
        try {
          // Timed from here, not from the decode: the RAW decode is the same work
          // whatever the quality, so including it would flatten the difference the
          // page exists to show.
          const started = Bun.nanoseconds();
          const settings = this.settings.get();
          saveAvif(image, settings.full_rendition_size, quality, AVIF_EFFORT, settings.sdr_full_chroma, file);
          encodeMs = Math.round((Bun.nanoseconds() - started) / 1e6);
        } finally {
          freeImage(image);
        }
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
      const first = this.photos.listByLibrary(library.id, { offset: 0, limit: 1, include_deleted: false }).photos[0];
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
    fetch('/quality-check/img/${photoId}/' + q)
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
