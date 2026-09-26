import path from 'node:path';
import { tmpdir } from 'node:os';
import { PathSegment, route } from '../src/schemas/route';
import { panoramaViews } from './pano-views';

// A panorama in a running library, so opening one in the editor can be checked by hand.
//
// ```text
// bun run dev            # in one terminal
// bun run scripts/dev-panorama.ts
// ```
//
// Writes six synthetic views into a library root, adds the library, waits for the scan, merges the
// frames into a composite, and prints the editor's URL for it. Everything it does is what a reader
// does through the interface; there is no back door into the catalogue here.
//
// **Under `dev:docker` the API is not published** - only the web port is, the API staying on
// loopback inside the shared namespace - so point this at the web server, which proxies `/api`:
//
// ```text
// BOWERBIRD_API=http://127.0.0.1:5173 bun run scripts/dev-panorama.ts
// ```
//
// The library root has to be a path the *container* can see, which for a live-mounted repo means
// somewhere under `/photos` rather than `/tmp`: `BOWERBIRD_PANO_ROOT=./photos/panorama` writes it
// where both sides agree.

const API = process.env.BOWERBIRD_API ?? 'http://127.0.0.1:3000';
const WEB = process.env.BOWERBIRD_WEB ?? 'http://127.0.0.1:5173';
const ROOT = process.env.BOWERBIRD_PANO_ROOT ?? path.join(tmpdir(), 'bowerbird-dev-panorama');

async function ask<T>(method: string, route: string, body?: unknown): Promise<T> {
  const reply = await fetch(`${API}${route}`, {
    method,
    headers: body == null ? {} : { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!reply.ok) throw new Error(`${method} ${route}: ${reply.status} ${(await reply.text()).slice(0, 300)}`);
  return (await reply.json()) as T;
}

interface Library {
  id: string;
  root_path: string;
}

interface Photo {
  id: string;
  filename?: string;
  composite_kind: string | null;
}

/** The library at this root, added if it is not there yet. */
async function library(): Promise<Library> {
  const held = await ask<Library[]>('GET', '/api/libraries');
  const found = held.find((each) => each.root_path === ROOT);
  if (found != null) return found;
  return ask<Library>('POST', '/api/libraries', {
    name: 'Panorama fixture',
    root_path: ROOT,
    // The views are PNGs, which a library ignores unless it is told to take them.
    include_non_raw: true,
    // Every view is a render of the same world a rotation apart, so stacking has little to tell
    // them apart - and a stack of the set is not what this merges.
    auto_stack: false,
  });
}

/** Returns once the scan has filed every view, or gives up saying how many it saw. */
async function scanned(id: string, want: number): Promise<Photo[]> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const { photos } = await ask<{ photos: Photo[] }>('GET', `/api/libraries/${id}/photos?limit=100`);
    const frames = photos.filter((photo) => photo.composite_kind == null);
    if (frames.length >= want) return frames;
    await new Promise((wake) => setTimeout(wake, 1000));
  }
  throw new Error(`the scan filed fewer than ${want} views`);
}

const views = panoramaViews(ROOT);
console.log(`${views.length} views in ${ROOT}`);

const found = await library();
console.log(`library ${found.id}`);
// A library that was just added is already scanning - the import begins as the row lands - so a
// sync asked for here is a 409 rather than a second pass. Asked anyway, for the run where the
// library was already there and the views are new.
try {
  await ask('POST', `/api/libraries/${found.id}/sync`);
} catch (error) {
  console.log(`  sync: ${error instanceof Error ? error.message.slice(0, 80) : error}`);
}
const frames = await scanned(found.id, views.length);
console.log(`${frames.length} frames filed`);

// Aligns, then builds the composite's grid and full renditions before it answers, so this is the
// slow call and what comes back is a photograph with pictures already on disk.
const { photoId } = await ask<{ photoId: string }>('POST', '/api/composites/panorama', {
  photo_ids: frames.map((frame) => frame.id),
});

console.log('');
console.log(`panorama ${photoId}`);
console.log(`  view   ${WEB}/photos/${photoId}`);
console.log(`  edit   ${WEB}${route(PathSegment.photos(), photoId, PathSegment.edit())}`);
