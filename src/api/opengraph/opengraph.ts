import type { Context } from 'hono';
import { AppError } from '../../errors';
import type { PhotoDetail, PhotoListResponse } from '../../schemas/photos';
import { PhotoListQuerySchema } from '../../schemas/photos';
import { isComposite, sourcesOf } from '../../schemas/recipes';
import { PathSegment, route } from '../../schemas/route';
import type { AlbumsService } from '../../services/albums/albums_service';
import type { LibrariesService } from '../../services/libraries/libraries_service';
import type { PhotoReadService } from '../../services/photos/listing/photo_read_service';
import type { ShootsService } from '../../services/shoots/shoots_service';
import { Logger } from '../../logger';
import { OpenGraphStrings } from './opengraph.strings';

const log = new Logger('opengraph');

interface Page {
  title: string;
  description: string | null;
  image: { id: string; builtAt: string | null } | null;
}

const COLLECTION = new RegExp(`^/(${PathSegment.libraries()}|${PathSegment.shoots()}|${PathSegment.albums()})/([^/]+)`);
const PHOTO = new RegExp(`/${PathSegment.photos()}/([^/]+)/?$`);
const MOST_RECENT = PhotoListQuerySchema.parse({ ordering: 'taken_desc', limit: 1, triage: 'untriaged,picked' });

/** Link-preview tags for the web client's pages, written into the shell a crawler is served. */
export class OpenGraph {
  constructor(
    private readonly libraries: LibrariesService,
    private readonly shoots: ShootsService,
    private readonly albums: AlbumsService,
    private readonly photos: PhotoReadService,
  ) {}

  /** The shell with this page's title and tags in its head, or unchanged for a page with nothing to describe. */
  inject(html: string, c: Context): string {
    const page = this.describe(c.req.path);
    if (page == null) return html;
    const origin = originOf(c);
    const tags: [string, string][] = [
      ['og:site_name', OpenGraphStrings.siteName()],
      ['og:type', 'website'],
      ['og:title', page.title],
      ['og:url', `${origin}${c.req.path}`],
    ];
    if (page.description != null) tags.push(['og:description', page.description], ['description', page.description]);
    if (page.image != null) {
      const url = `${origin}${route(PathSegment.image(), page.image.id, PathSegment.preview())}`;
      // Versioned so an unfurler's cache lets go of a tile rebuilt after an edit.
      tags.push(['og:image', page.image.builtAt == null ? url : `${url}?v=${Date.parse(page.image.builtAt)}`]);
    }
    tags.push(['twitter:card', page.image == null ? 'summary' : 'summary_large_image']);
    const meta = tags
      .map(([key, value]) => `<meta ${key.startsWith('og:') ? 'property' : 'name'}="${key}" content="${Bun.escapeHTML(value)}" />`)
      .join('');
    return new HTMLRewriter()
      .on('title', {
        element: (title) => {
          title.setInnerContent(`${page.title} - ${OpenGraphStrings.siteName()}`);
          title.after(meta, { html: true });
        },
      })
      .transform(html);
  }

  private describe(pathname: string): Page | null {
    try {
      const photoId = PHOTO.exec(pathname)?.[1];
      if (photoId != null) return this.describePhoto(this.photos.get(photoId));
      const [, kind, id] = COLLECTION.exec(pathname) ?? [];
      if (id == null) return null;
      if (kind === PathSegment.shoots()) {
        return this.describeCollection(this.shoots.get(id).name, this.photos.listByShoot(id, MOST_RECENT));
      }
      if (kind === PathSegment.albums()) {
        return this.describeCollection(this.albums.get(id).name, this.photos.listByAlbum(id, MOST_RECENT));
      }
      return this.describeCollection(this.libraries.get(id).name, this.photos.listByLibrary(id, MOST_RECENT));
    } catch (err) {
      // Whatever went wrong, the reader still gets the app, just without a preview.
      if (!(err instanceof AppError && err.code === 'NOT_FOUND')) {
        log.warn('could not describe a page for its link preview', { path: pathname, err: String(err) });
      }
      return null;
    }
  }

  private describePhoto(photo: PhotoDetail): Page {
    const title =
      isComposite(photo.recipe) ?
        OpenGraphStrings.panorama(sourcesOf(photo.recipe).length)
      : (photo.file_path?.split('/').pop() ?? photo.id);
    const exposure = [
      photo.focal_length == null ? null : OpenGraphStrings.focalLength(photo.focal_length),
      photo.aperture == null ? null : OpenGraphStrings.aperture(photo.aperture),
      photo.shutter_speed == null || photo.shutter_speed <= 0 ? null : OpenGraphStrings.shutter(photo.shutter_speed),
      photo.iso == null ? null : OpenGraphStrings.iso(photo.iso),
    ].filter((part) => part != null);
    const description = [
      photo.date_taken?.slice(0, 10),
      dedupeMake(photo.camera_make, photo.camera_model).join(' '),
      photo.lens_model,
      exposure.join(' '),
    ].filter((part) => part != null && part !== '');
    return {
      title,
      description: description.length === 0 ? null : description.join(' · '),
      image: { id: photo.id, builtAt: photo.tile_built_at },
    };
  }

  private describeCollection(title: string, recent: PhotoListResponse): Page {
    const newest = recent.photos[0];
    return {
      title,
      description: recent.photo_total == null ? null : OpenGraphStrings.photoCount(recent.photo_total),
      image: newest == null ? null : { id: newest.id, builtAt: newest.tile_built_at },
    };
  }
}

function dedupeMake(make: string | null, model: string | null): string[] {
  if (make == null || model == null) return [make, model].filter((part) => part != null);
  return model.toLowerCase().startsWith(make.toLowerCase()) ? [model] : [make, model];
}

// Behind a TLS-terminating proxy the request itself arrived as plain http, and a crawler
// refuses an `og:image` on a scheme the page was not served over.
function originOf(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1);
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim() || url.host;
  return `${proto}://${host}`;
}
