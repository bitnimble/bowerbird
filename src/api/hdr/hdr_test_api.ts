import { Hono } from 'hono';
import { AppError } from '../../errors';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import type { PhotosService } from '../../services/photos/photos_service';
import { HDR_MEDIA, HDR_VARIANTS, contentTypeFor, type HdrMedium } from '../../services/processing/hdr_media';

// A page for looking at the HDR renditions on real hardware (DESIGN §10.7).
//
// This exists as a page rather than a test because HDR output cannot be
// observed from script: the browser hands the frame to the compositor, which
// hands it to the monitor, and everything readable back through a canvas has
// already been tone-mapped to SDR. Whether it worked is a question only an eye
// in front of the panel can answer, so the job here is to put the renditions
// side by side and get out of the way.
export class HdrTestApi {
  readonly routes: Hono;

  constructor(
    private readonly photos: PhotosService,
    private readonly libraries: LibrariesService,
  ) {
    const app = new Hono();
    // No id: the point is to be typeable into a phone's address bar, so the
    // whole URL has to be the host and this path.
    app.get('/', (c) => {
      const ids = this.photoIds();
      const first = ids[0];
      if (first == null) throw new AppError('NOT_FOUND', 'no photos catalogued yet');
      return c.html(page(first, ids));
    });
    // Through the catalogue, not straight from the URL: the id is interpolated
    // into the page's markup and script, so reflecting the parameter verbatim
    // would be reflected XSS. What gets rendered is the id the database holds.
    app.get('/:photoId', (c) => c.html(page(this.photos.locate(c.req.param('photoId') ?? '').photo.id, this.photoIds())));
    this.routes = app;
  }

  private photoIds(): string[] {
    // A handful to step through, so a frame with no highlights to judge is not
    // the end of the exercise.
    return this.libraries
      .list()
      .flatMap((library) =>
        this.photos
          .listByLibrary(library.id, { offset: 0, limit: 12, include_deleted: false })
          .photos.map((photo) => photo.id),
      );
  }
}

// No src here: the elements are empty until the build POST returns, so the page
// never shows six broken players while it waits.
function cells(medium: HdrMedium): string {
  // Medium and variant as separate attributes, not one hyphen-joined id: a
  // medium is allowed to contain a hyphen ('still-baseline'), and splitting such
  // an id on '-' silently yields the wrong pair and a URL that 404s.
  const isStill = contentTypeFor(medium).startsWith('image/');
  return HDR_VARIANTS.map((variant) => {
    const attrs = `data-medium="${medium}" data-variant="${variant}"`;
    const element = isStill
      ? `<img ${attrs} alt="${variant} still">`
      : `<video ${attrs} autoplay loop muted playsinline></video>`;
    return `
      <figure>
        <figcaption>${variant.toUpperCase()} <span data-size="${medium}/${variant}"></span></figcaption>
        ${element}
      </figure>`;
  }).join('');
}

const HEADING: Record<HdrMedium, string> = {
  still: 'Stills, AVIF 4:4:4 (Advanced profile)',
  'still-baseline': 'Stills, AVIF 4:2:0 (Baseline, control)',
  video: 'Video, one-frame AV1 4:2:0 (Profile 0)',
};

// The renditions are built by the POST the page fires on load, so a first visit
// waits on every encode rather than showing broken players.
function page(photoId: string, ids: string[]): string {
  const at = ids.indexOf(photoId);
  const next = ids[(at + 1) % Math.max(1, ids.length)] ?? photoId;

  const sections = HDR_MEDIA.map(
    (medium) => `
      <section>
        <h2>${HEADING[medium]}</h2>
        <div class="row">${cells(medium)}</div>
      </section>`,
  ).join('');

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HDR check</title>
<style>
  :root { color-scheme: dark; }
  body { background: #000; color: #999; font: 13px/1.4 system-ui, sans-serif; margin: 0; padding: 12px; }
  h1 { font-size: 16px; margin: 0 0 8px; color: #ddd; }
  h2 { font-size: 12px; font-weight: 600; letter-spacing: .1em; margin: 20px 0 6px; color: #ddd; }
  /* Three across at every width. Stacking them would put the panels being
     compared a scroll apart, and a brightness difference you cannot see side by
     side is one you cannot judge at all. */
  .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  figure { margin: 0; min-width: 0; }
  figcaption { padding: 3px 0; font-size: 11px; letter-spacing: .06em; }
  img, video { width: 100%; display: block; background: #111; }
  /* Nearest-neighbour. On a downscale this aliases rather than resolving more
     detail, so it reads sharper without being more accurate - which is the
     point of having it as a toggle rather than a setting. */
  body.sharp img, body.sharp video { image-rendering: pixelated; }
  label { display: inline-flex; gap: 6px; align-items: center; margin: 8px 0; color: #ddd; }
  /* Tap a panel to give it the full width; three-up is for comparing, one-up is
     for actually looking at the highlights. */
  .row.expanded { grid-template-columns: 1fr; }
  .row.expanded figure { display: none; }
  .row.expanded figure.open { display: block; }
  nav { margin: 14px 0 0; }
  a { color: #7fd; }
  #status { color: #ddd; }
  code { color: #7fd; overflow-wrap: anywhere; font-size: 11px; }
</style>
<h1>HDR check</h1>
<p id="status">building six renditions, this takes a while…</p>
<p>
  Compare PQ against SDR within a row. Where HDR is working the PQ panel shows
  highlights brighter than SDR can reach; if they match, that medium's tagging is
  being ignored. Chrome and Safari do the stills; the video is for Firefox, and
  only on Windows. The 4:2:0 row is a control: if it renders where the 4:4:4 row
  does not, the decoder lacks AVIF Advanced profile rather than lacking HDR.
  Tap a panel to expand it.
  <br><code id="range"></code>
  <br><code id="codecs"></code>
</p>
<label><input type="checkbox" id="sharp"> Sharp scaling (image-rendering: pixelated)</label>
${sections}
<nav><a href="/hdr-check/${next}">Next photo →</a></nav>
<script>
  const status = document.getElementById('status');
  document.getElementById('range').textContent =
    'dynamic-range: high = ' + matchMedia('(dynamic-range: high)').matches +
    ' | video-dynamic-range: high = ' + matchMedia('(video-dynamic-range: high)').matches;

  // These are fitted to a judging size rather than shown at the sensor's own, so
  // report what actually came back rather than implying full resolution.
  function label(cell, text) {
    document.querySelector('[data-size="' + cell + '"]').textContent = text;
  }

  // A blank panel is otherwise indistinguishable from a slow one, and the usual
  // cause is the browser refusing the codec rather than anything about HDR:
  // Firefox on Android ships with media.av1.enabled off, which fails all three
  // videos whatever their tagging.
  function failed(cell, el) {
    const error = el.error == null ? '' : ' (' + el.error.code + ')';
    label(cell, 'FAILED' + error);
    el.parentElement.querySelector('figcaption').style.color = '#f77';
  }

  // What the browser claims before anything is loaded, so a refusal can be told
  // apart from a decode that went wrong.
  const probe = document.createElement('video');
  document.getElementById('codecs').textContent =
    'av1 in mp4: "' + probe.canPlayType('video/mp4; codecs="av01.0.08M.10"') + '"';

  const sharp = document.getElementById('sharp');
  sharp.addEventListener('change', () => document.body.classList.toggle('sharp', sharp.checked));

  for (const figure of document.querySelectorAll('figure')) {
    figure.addEventListener('click', () => {
      const row = figure.parentElement;
      const opening = !figure.classList.contains('open');
      for (const other of row.querySelectorAll('figure')) other.classList.remove('open');
      figure.classList.toggle('open', opening);
      row.classList.toggle('expanded', opening);
    });
  }

  fetch('/api/photos/${photoId}/hdr', { method: 'POST' })
    .then((r) => {
      if (!r.ok) throw new Error('build failed: ' + r.status);
      for (const el of document.querySelectorAll('[data-medium]')) {
        const medium = el.dataset.medium;
        const variant = el.dataset.variant;
        const cell = medium + '/' + variant;
        if (el.tagName === 'IMG') {
          el.addEventListener('load', () => label(cell, el.naturalWidth + '\\u00d7' + el.naturalHeight));
        } else {
          el.addEventListener('loadedmetadata', () => label(cell, el.videoWidth + '\\u00d7' + el.videoHeight));
        }
        el.addEventListener('error', () => failed(cell, el));
        el.src = '/image/${photoId}/hdr/' + medium + '/' + variant;
      }
      status.textContent = 'built. A blank panel means that codec did not decode.';
    })
    .catch((e) => { status.textContent = String(e); });
</script>`;
}
