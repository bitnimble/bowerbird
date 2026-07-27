import { Hono } from 'hono';
import { HDR_VARIANTS } from '../../services/processing/hdr_video';
import type { PhotosService } from '../../services/photos/photos_service';

// A page for looking at the HDR stills on a real HDR display (DESIGN §10.7).
//
// This exists as a page rather than a test because HDR output cannot be
// observed from script: the browser hands the frame to the compositor, which
// hands it to the monitor, and everything readable back through a canvas has
// already been tone-mapped to SDR. Whether it worked is a question only an eye
// in front of the panel can answer, so the job here is to put the variants side
// by side and get out of the way.
export class HdrTestApi {
  readonly routes: Hono;

  constructor(private readonly photos: PhotosService) {
    const app = new Hono();
    app.get('/:photoId', (c) => c.html(page(c.req.param('photoId'))));
    this.routes = app;
  }
}

// The videos are built by the POST the page fires on load, so a first visit
// waits on three encodes rather than showing three broken players.
function page(photoId: string): string {
  const players = HDR_VARIANTS.map(
    (variant) => `
      <figure>
        <figcaption>${variant.toUpperCase()} <span data-size="${variant}"></span></figcaption>
        <video data-variant="${variant}" controls autoplay loop muted playsinline></video>
      </figure>`,
  ).join('');

  return `<!doctype html>
<meta charset="utf-8">
<title>HDR check ${photoId}</title>
<style>
  body { background: #000; color: #bbb; font: 14px system-ui, sans-serif; margin: 0; padding: 16px; }
  .row { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
  figure { margin: 0; flex: 1 1 320px; }
  figcaption { padding: 4px 0; letter-spacing: .08em; }
  video { width: 100%; display: block; background: #000; }
  #status { padding: 8px 0; }
  code { color: #7fd; }
</style>
<h1>HDR check</h1>
<p id="status">building…</p>
<p>
  Compare PQ and HLG against SDR. On a display and browser doing HDR, the two
  HDR panels should show highlights brighter than SDR can reach; if all three
  look identical the transfer is being ignored.
  <code id="range"></code>
</p>
<div class="row">${players}</div>
<script>
  const status = document.getElementById('status');
  document.getElementById('range').textContent =
    'dynamic-range: high = ' + matchMedia('(dynamic-range: high)').matches +
    ', video-dynamic-range: high = ' + matchMedia('(video-dynamic-range: high)').matches;

  fetch('/api/photos/${photoId}/hdr', { method: 'POST' })
    .then((r) => {
      if (!r.ok) throw new Error('build failed: ' + r.status);
      for (const video of document.querySelectorAll('video')) {
        const variant = video.dataset.variant;
        // AV1 cannot take a current sensor at native size, so the encode fits it
        // to a long edge. Show what actually came back rather than implying full
        // resolution.
        video.addEventListener('loadedmetadata', () => {
          document.querySelector('[data-size="' + variant + '"]').textContent =
            video.videoWidth + '\\u00d7' + video.videoHeight;
        });
        video.src = '/image/${photoId}/hdr/' + variant;
      }
      status.textContent = 'built. If a panel is blank, that codec did not decode.';
    })
    .catch((e) => { status.textContent = String(e); });
</script>`;
}
