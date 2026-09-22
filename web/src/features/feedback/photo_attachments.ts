import type { PhotoDetail } from '../../../../src/schemas/photos';
import { exportsApi } from '../../api/exports';
import { type AttachableForm, photosApi } from '../../api/photos';

/** One file riding with a report, in the shape Sentry's envelope takes. */
export interface Attached {
  filename: string;
  data: Uint8Array;
  contentType: string;
}

export interface PhotoChoice {
  photo: PhotoDetail;
  /** The original as the camera wrote it, which is the one attachment with a size worth a rule. */
  raw: boolean;
  strip: boolean;
}

/** Sentry refuses a request over 40MB outright, with a 413 and no event (DESIGN §18.8). */
export const REQUEST_CEILING = 40 * 1024 * 1024;

/**
 * Whether the original could ride along at all, which is what greys the control out.
 *
 * The whole ceiling, because what the pictures beside it will weigh is not known until they
 * have been built - so this is the question the control can answer, and `attachmentsFor` asks
 * the exact one once it has them.
 */
export function rawFits(photo: PhotoDetail): boolean {
  return photo.file_size != null && photo.file_size <= REQUEST_CEILING;
}

/** A report that cannot be sent as it stands, rather than one that failed to send. */
export class ReportTooLarge extends Error {
  constructor() {
    super('the original will not fit in this report');
    this.name = 'ReportTooLarge';
  }
}

/**
 * Everything the report carries about the photograph on screen: the camera's own JPEG, the
 * picture this pipeline makes of it in both ranges, what has been measured about it, and the
 * original where it was asked for.
 *
 * **Both renders, because the two answer different questions.** The AVIF is the rendition the
 * reader is actually looking at, and the JPEG is the same frame rolled to sRGB - so a report
 * about a colour can be opened by anything, and one about the HDR still has the HDR.
 *
 * A picture that will not build is left out rather than failing the whole report. The original
 * is not: a reader who ticked it has been told their file would be scrubbed and sent, and a
 * server that cannot scrub it refuses rather than sending it as it is.
 */
export async function attachmentsFor({ photo, raw, strip }: PhotoChoice): Promise<Attached[]> {
  const forms: AttachableForm[] = [...(photo.has_embedded ? (['embedded'] as const) : []), 'full', 'analysis'];
  // Caught as each is started rather than as each is awaited: they run together, so one that
  // fails while an earlier one is still in flight would otherwise be an unhandled rejection
  // for as long as the loop takes to reach it.
  const optional = [
    // Only the camera's own file is asked for scrubbed: a rendition and a measurement are this
    // pipeline's, and were never written with a tag naming anybody.
    ...forms.map((form) => named(`${photo.id}-${form}`, photosApi.attachment(photo.id, form, strip && form === 'embedded'))),
    named(`${photo.id}-sdr`, rolledToSdr(photo.id)),
  ].map((pending) => pending.catch(() => null));

  const attached: Attached[] = [];
  for (const pending of optional) {
    const part = await pending;
    if (part != null) attached.push(part);
  }

  if (raw) {
    // Weighed against what the pictures actually came to, and before the fetch rather than
    // after it: the alternative is pulling tens of megabytes across to refuse the report that
    // was holding them. `rawFits` cannot ask this - it runs before there is anything to weigh.
    const carried = attached.reduce((total, part) => total + part.data.byteLength, 0);
    if (carried + (photo.file_size ?? 0) > REQUEST_CEILING) throw new ReportTooLarge();
    const original = await photosApi.attachment(photo.id, 'original', strip);
    attached.push({
      filename: original.filename ?? photo.id,
      data: original.bytes,
      contentType: original.mediaType,
    });
  }
  return attached;
}

/** The same frame this pipeline renders, rolled to sRGB, for a reader with no HDR display. */
function rolledToSdr(photoId: string): Promise<{ bytes: Uint8Array; mediaType: string; filename: string | null }> {
  return exportsApi.create({
    photoId,
    options: {
      format: 'jpeg',
      quality: 95,
      longEdge: 0,
      includeEdits: true,
      halfSize: false,
      exportHdr: false,
      gainMap: false,
    },
  });
}

/**
 * Under the photograph's id and what it is rather than under the filename the server sent.
 *
 * Every part of one report sorts together in Sentry that way, and the two renders of one frame
 * do not arrive as the same name twice.
 */
async function named(
  stem: string,
  pending: Promise<{ bytes: Uint8Array; mediaType: string }>,
): Promise<Attached> {
  const file = await pending;
  return { filename: `${stem}${extension(file.mediaType)}`, data: file.bytes, contentType: file.mediaType };
}

function extension(contentType: string): string {
  if (contentType.includes('avif')) return '.avif';
  if (contentType.includes('jpeg')) return '.jpg';
  return '.bin';
}
