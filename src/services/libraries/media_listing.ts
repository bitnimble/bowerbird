import { z } from 'zod';
import { Logger } from '../../logger';
import { askShell, parsedOrNull } from './shell_socket';

const log = new Logger('media-listing');

const ANSWER_TIMEOUT_MS = 30_000;
const THUMBNAIL_TIMEOUT_MS = 10_000;
const QUEUED_THUMBNAILS_AT_ONCE = 4;
const QUEUED_THUMBNAILS_WAITING = 64;

export interface MediaEntry {
  size: number;
  width: number | null;
  height: number | null;
  orientationDegrees: number | null;
  takenWallMs: number | null;
  /** What `thumbnail` takes; null where the device keeps no thumbnail for it. */
  imageId: number | null;
}

export interface MediaListing {
  /** Every file under `root` the device's media index knows, by absolute path; null when the index can't be asked. */
  under(root: string): Promise<ReadonlyMap<string, MediaEntry> | null>;
  /**
   * The device's own JPEG of an image: `'gone'` where the device says it has none for that file any
   * more, null where it could not be asked.
   */
  thumbnail(imageId: number, path: string): Promise<Uint8Array | 'gone' | null>;
  /**
   * `thumbnail`, a few at a time and newest first, for one the device may still have to make. Null
   * as well where newer asks pushed this one out of the queue.
   */
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
  z.object({ error: z.string() }),
]);

export class ShellMediaListing implements MediaListing {
  private asking = 0;
  private readonly waiting: ((turn: boolean) => void)[] = [];

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
    else if (!(await this.turn())) return null;
    try {
      return await this.thumbnail(imageId, path);
    } finally {
      // Handed straight to the newest waiting, so a caller arriving in between can't take it too.
      const next = this.waiting.pop();
      if (next == null) this.asking--;
      else next(true);
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
    if ('error' in reply.data) {
      log.warn('the app has no thumbnail for this image', { imageId, error: reply.data.error });
      return 'gone';
    }
    return Buffer.from(reply.data.jpeg, 'base64');
  }

  /** Whether this ask got a turn, rather than being pushed out by newer ones. */
  private turn(): Promise<boolean> {
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length > QUEUED_THUMBNAILS_WAITING) this.waiting.shift()?.(false);
    });
  }
}
