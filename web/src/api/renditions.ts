import { PathSegment, route } from '../../../src/schemas/route';
import { type RenditionJobResponse, RenditionJobResponseSchema } from '../../../src/schemas/photos';
import type { Rendition } from '../../../src/services/processing/renditions/renditions';
import { assetUrl } from './transport';
import { errorFrom, NothingSchema, request } from './request';

function renditionUrl(photoId: string, rendition: Rendition, version = 0): string {
  const url = assetUrl(route(PathSegment.image(), photoId, PathSegment.renditions(), rendition));
  return version === 0 ? url : `${url}?v=${version}`;
}

export const renditionsApi = {
  build: (photoId: string, rendition: Rendition, force = false): Promise<void> =>
    request(
      NothingSchema,
      'POST',
      `${route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.renditions(), rendition)}${force ? '?force=true' : ''}`,
    ),
  // The same build as a job for this device to render; a null job is the server's to build.
  job: (photoId: string, rendition: Rendition, force = false): Promise<RenditionJobResponse> =>
    request(
      RenditionJobResponseSchema,
      'GET',
      `${route(PathSegment.api(), PathSegment.photos(), photoId, PathSegment.renditions(), rendition, PathSegment.job())}${force ? '?force=true' : ''}`,
    ),

  // `version` is appended only once renditions have been rebuilt in this session:
  // the file changes behind a stable URL, and an image already decoded in the page
  // is never re-requested without it.
  // One URL shape for every rendition, `embedded` included: what a row is asked for is one
  // question and how it answers is its recipe's, so a client naming a copy never has to know
  // whether that copy is a file on disk or bytes lifted out of the original (§10.2). Dynamic
  // range is not in the URL either: the library decides it, so a client guessing would ask for
  // a file that was never built. Firefox is served the same AVIF as everything else and rewraps
  // it into a video for itself (`hdr_video.ts`).
  url: renditionUrl,

  /** Hands the server a rendition this device rendered, gzipped, for it to encode and keep. */
  keep: async (
    photoId: string,
    rendition: Rendition,
    builtFrom: string | null,
    rendered: Uint8Array<ArrayBuffer>,
  ): Promise<void> => {
    const url = renditionUrl(photoId, rendition);
    const reply = await fetch(builtFrom == null ? url : `${url}?builtFrom=${encodeURIComponent(builtFrom)}`, {
      method: 'PUT',
      body: rendered,
    });
    if (!reply.ok) throw errorFrom(reply.status, await reply.text());
  },
};
