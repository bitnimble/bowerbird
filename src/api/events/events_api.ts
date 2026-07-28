import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ProcessingService } from '../../services/processing/processing_service';

export interface PhotoEvent {
  // Monotonic for the life of the process, so a reconnecting client can name the
  // last one it saw.
  id: number;
  photoId: string;
  // The photo's new `date_reprocessed`, which is what a client puts in its image
  // URLs. Carried on the event so that learning of a rebuild costs nothing beyond
  // the event: the client writes it into the row it is already holding.
  version: string;
}

// How far back a reconnecting client can be caught up. A browser retries a
// dropped stream within seconds, so this only has to cover a blip; a client gone
// longer than the buffer re-reads the collection when it comes back.
const REPLAY = 512;

// A stream nothing writes to is indistinguishable from a dead one, and Bun idles
// a silent socket out well before a quiet library produces an event (index.ts).
const HEARTBEAT_MS = 20_000;

// Tells clients which photos have a freshly built thumbnail. Thumbnails are
// written asynchronously, so a tile rendered during an import asks for a file
// that is not there yet; this is how it learns to ask again, for that one photo,
// at the moment there is something to fetch (DESIGN §18.6).
export class EventsApi {
  readonly routes: Hono;

  private nextId = 1;
  private readonly recent: PhotoEvent[] = [];
  private readonly clients = new Set<(event: PhotoEvent) => void>();

  constructor(processing: ProcessingService) {
    processing.onProcessed((photoId, version) => this.publish(photoId, version));

    const app = new Hono();

    app.get('/', (c) =>
      streamSSE(c, async (stream) => {
        // One chain, because two overlapping writes on the same stream interleave
        // their chunks and neither event parses.
        let queued = Promise.resolve();
        const write = (message: { event: string; data: string; id?: string }): Promise<void> => {
          queued = queued.then(() => stream.writeSSE(message)).catch(() => {});
          return queued;
        };

        const send = (event: PhotoEvent): void => {
          void write({ id: String(event.id), event: 'thumbnail', data: JSON.stringify({ id: event.photoId, version: event.version }) });
        };
        for (const event of this.since(c.req.header('Last-Event-ID'))) send(event);
        this.clients.add(send);

        // The heartbeat waits on the timer *or* the disconnect, rather than
        // sleeping through it: a dropped client would otherwise hold this handler
        // and its subscription until the next beat, and hold the process open
        // that long at shutdown.
        let wake = (): void => {};
        stream.onAbort(() => {
          this.clients.delete(send);
          wake();
        });
        while (!stream.aborted && !stream.closed) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, HEARTBEAT_MS);
            wake = (): void => {
              clearTimeout(timer);
              resolve();
            };
          });
          if (stream.aborted || stream.closed) break;
          await write({ event: 'ping', data: '' });
        }
        this.clients.delete(send);
      }),
    );

    this.routes = app;
  }

  // Everything after the last event the client acknowledged. An id this process
  // never issued replays nothing rather than the whole buffer: the usual cause is
  // a server restart, where the ids belong to a previous run and the client's
  // tiles are about to be re-requested by a reload anyway.
  since(lastEventId: string | undefined): PhotoEvent[] {
    const last = Number(lastEventId);
    if (!Number.isInteger(last) || last <= 0 || last >= this.nextId) return [];
    return this.recent.filter((event) => event.id > last);
  }

  private publish(photoId: string, version: string): void {
    const event: PhotoEvent = { id: this.nextId++, photoId, version };
    this.recent.push(event);
    if (this.recent.length > REPLAY) this.recent.shift();
    for (const send of this.clients) send(event);
  }
}
