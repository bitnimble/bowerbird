import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { DEFAULT_LIBRARY_SETTINGS, type Library } from '../../../schemas/libraries';
import { fileRecipe } from '../../../schemas/recipes';
import { PathSegment, route } from '../../../schemas/route';
import { DEFAULT_SETTINGS } from '../../../schemas/settings';
import { LibraryActivity } from '../../../services/activity/library_activity';
import type { BasicPhoto } from '../../../services/photos/paths/photo_paths_repository';
import { applyErrorHandler } from '../../error_handler';
import { QualityCheckApi } from '../quality_check_api';

function context(): { app: Hono; activity: LibraryActivity; library: Library; photo: BasicPhoto; root: string; cache: string; url: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'bb-quality-'));
  const library: Library = {
    ...DEFAULT_LIBRARY_SETTINGS,
    id: path.basename(root), root_path: root, name: 'Quality', bin_name: 'Bin', read_only: false,
    ordering: 'taken_desc', last_synced_at: null,
    photo_count: 1, missing_photo_count: 0, unavailable_photo_count: 0, rendered_photo_count: 0,
  };
  const photo: BasicPhoto = { id: path.basename(root), library_id: library.id, shoot_id: null, recipe: fileRecipe('invalid.ARW') };
  const cache = path.join(tmpdir(), 'bowerbird-quality-check', `${photo.id}-80-${DEFAULT_SETTINGS.avif_speed}-${library.denoiser}.avif`);
  writeFileSync(path.join(root, 'invalid.ARW'), 'not a RAW');
  const activity = new LibraryActivity();
  const api = new QualityCheckApi(
    { listByLibrary: () => { throw new Error('not listing photos'); } },
    { locate: () => ({ library, photo }) },
    { list: () => [library] },
    { get: () => DEFAULT_SETTINGS },
    { open: async () => path.join(root, 'invalid.ARW') },
    activity,
  );
  const app = new Hono();
  app.route(route(PathSegment.qualityCheck()), api.routes);
  applyErrorHandler(app);
  return { app, activity, library, photo, root, cache, url: route(PathSegment.qualityCheck(), PathSegment.img(), photo.id, '80') };
}

test('a failed quality render runs off the server thread and clears its library activity', async () => {
  const { app, activity, library, root, cache, url } = context();
  let visible = false;
  const timer = setInterval(() => {
    if (activity.current(library.id).some(({ kind }) => kind === 'checking_quality')) visible = true;
  }, 0);
  try {
    const response = await app.request(url);
    expect(response.status).toBe(500);
    expect(visible).toBe(true);
    expect(activity.current(library.id)).toEqual([]);
    expect(await Bun.file(cache).exists()).toBe(false);
  } finally {
    clearInterval(timer);
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { force: true });
  }
});

test('cached quality renditions are served without starting activity', async () => {
  const { app, activity, library, root, cache, url } = context();
  try {
    mkdirSync(path.dirname(cache), { recursive: true });
    writeFileSync(cache, 'AVIFDATA');
    const response = await app.request(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/avif');
    expect(response.headers.get('X-Encode-Ms')).toBe('0');
    expect(await response.text()).toBe('AVIFDATA');
    expect(activity.current(library.id)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cache, { force: true });
  }
});
