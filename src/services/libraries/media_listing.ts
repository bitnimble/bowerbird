import { z } from 'zod';
import { Logger } from '../../logger';
import { askShell, parsedOrNull } from './shell_socket';

const log = new Logger('media-listing');

const ANSWER_TIMEOUT_MS = 30_000;

export interface MediaEntry {
  size: number;
  width: number | null;
  height: number | null;
  orientationDegrees: number | null;
  takenWallMs: number | null;
}

export interface MediaListing {
  /** Every file under `root` the device's media index knows, by absolute path; null when the index can't be asked. */
  under(root: string): Promise<ReadonlyMap<string, MediaEntry> | null>;
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
      ]),
    ),
  }),
  z.object({ error: z.string() }),
]);

export class ShellMediaListing implements MediaListing {
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
      reply.data.media.map(([path, size, width, height, orientationDegrees, takenWallMs]) => [
        path,
        { size, width, height, orientationDegrees, takenWallMs },
      ]),
    );
  }
}
