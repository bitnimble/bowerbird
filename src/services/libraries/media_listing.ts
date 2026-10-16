import { z } from 'zod';
import { Logger } from '../../logger';
import { askShell, parsedOrNull } from './shell_socket';

const log = new Logger('media-listing');

const ANSWER_TIMEOUT_MS = 30_000;
const THUMBNAIL_TIMEOUT_MS = 10_000;
const QUEUED_THUMBNAILS_AT_ONCE = 4;

export interface MediaEntry {
  size: number;
  width: number | null;
  height: number | null;
  orientationDegrees: number | null;
  takenWallMs: number | null;
  /** Null where the device keeps no thumbnail. */
  imageId: number | null;
}

export interface MediaListing {
  /** Every file under `root` the device's media index knows, by absolute path; null when the index can't be asked. */
  under(root: string): Promise<ReadonlyMap<string, MediaEntry> | null>;
  /** `'gone'`: device has none for that file; null: couldn't ask. */
  thumbnail(imageId: number, path: string): Promise<Uint8Array | 'gone' | null>;
  /** `thumbnail`, a few at a time, newest first. */
  queueThumbnail(imageId: number, path: string): Promise<Uint8Array | 'gone' | null>;
}

const MediaReplySchema = z.union([
  z.object({
    media: z.array(
      z.tuple([
        z.string(),
        z.number(),
        z.number().nullable(),
        z.number().nullable(),
        z.number().nullable(),
        z.number().nullable(),
        z.number().nullable(),
      ]),
    ),
  }),
  z.object({ error: z.string() }),
]);

const ThumbnailReplySchema = z.union([
  z.object({ jpeg: z.string() }),
  z.object({ gone: z.literal(true) }),
  z.object({ error: z.string() }),
]);

export class ShellMediaListing implements MediaListing {
  private asking = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly socketPath: string) {}

  async under(root: string): Promise<ReadonlyMap<string, MediaEntry> | null> {
    let line: string;
    try {
      line = await askShell(this.socketPath, { list_media: root }, ANSWER_TIMEOUT_MS);
    } catch (err) {
      log.warn('could not ask the app for its media listing', { root, err });
      return null;
    }
    const reply = MediaReplySchema.safeParse(parsedOrNull(line));
    if (!reply.success) {
      log.warn('the app answered a media listing with something unreadable', {
        root,
        line: line.slice(0, 200),
      });
      return null;
    }
    if ('error' in reply.data) {
      log.warn('the app could not list its media', { root, error: reply.data.error });
      return null;
    }
    return new Map(
      reply.data.media.map(
        ([path, size, width, height, orientationDegrees, takenWallMs, imageId]) => [
          path,
          { size, width, height, orientationDegrees, takenWallMs, imageId },
        ],
      ),
    );
  }

  async queueThumbnail(imageId: number, path: string): Promise<Uint8Array | 'gone' | null> {
    if (this.asking < QUEUED_THUMBNAILS_AT_ONCE) this.asking++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await this.thumbnail(imageId, path);
    } finally {
      // Handed over without freeing the slot, else a caller arriving in between takes it too.
      const next = this.waiting.pop();
      if (next == null) this.asking--;
      else next();
    }
  }

  async thumbnail(imageId: number, path: string): Promise<Uint8Array | 'gone' | null> {
    let line: string;
    try {
      line = await askShell(this.socketPath, { thumbnail: [imageId, path] }, THUMBNAIL_TIMEOUT_MS);
    } catch (err) {
      log.warn('could not ask the app for a thumbnail', { imageId, err });
      return null;
    }
    const reply = ThumbnailReplySchema.safeParse(parsedOrNull(line));
    if (!reply.success) {
      log.warn('the app answered a thumbnail with something unreadable', {
        imageId,
        line: line.slice(0, 200),
      });
      return null;
    }
    if ('gone' in reply.data) return 'gone';
    if ('error' in reply.data) {
      log.warn('the app could not read a thumbnail', { imageId, error: reply.data.error });
      return null;
    }
    return Buffer.from(reply.data.jpeg, 'base64');
  }
}
