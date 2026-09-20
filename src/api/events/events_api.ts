import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { type LibraryEventKind, type LibraryEventPayload, LibraryEventSchemas } from '../../schemas/events';
import { route } from '../../schemas/route';
import type { ProcessingService } from '../../services/processing/pipeline/processing_service';

export interface LibraryEvent {
  // Monotonic for the life of the process, so a reconnecting client can name the
  // last one it saw.
  id: number;
  kind: LibraryEventKind;
  data: string;
}

// How far back a reconnecting client can be caught up. A browser retries a
// dropped stream within seconds, so this only has to cover a blip; a client gone
// longer than the buffer re-reads the collection when it comes back.
const REPLAY = 512;

// A stream nothing writes to is indistinguishable from a dead one, and Bun idles
// a silent socket out well before a quiet library produces an event (index.ts).
const HEARTBEAT_MS = 20_000;

// What happened on this server that nobody asked about.
//
// Renditions are written asynchronously, so a tile rendered during an import asks
// for a file that is not there yet; this is how it learns to ask again, for that
// one photo, at the moment there is something to fetch (DESIGN §18.6).
// Replication runs on its own timer and answers peers that dial in, so what a
// session wrote about its peers - and what it failed at (docs/replication.md
// §8.6) - reaches the sidebar the same way.
export class EventsApi {
  readonly routes: Hono;

  private nextId = 1;
  private readonly recent: LibraryEvent[] = [];
  private readonly clients = new Set<(event: LibraryEvent) => void>();

  constructor(processing: ProcessingService) {
    processing.onProcessed((photoId, written) =>
      this.announce('rendition', { id: photoId, stage: written.stage, version: written.version }),
    );

    const app = new Hono();

    app.get(route(), (c) =>
      streamSSE(c, async (stream) => {
        // One chain, because two overlapping writes on the same stream interleave
        // their chunks and neither event parses.
        let queued = Promise.resolve();
        const write = (message: { event: string; data: string; id?: string }): Promise<void> => {
          queued = queued.then(() => stream.writeSSE(message)).catch(() => {});
          return queued;
        };

        const send = (event: LibraryEvent): void => {
          void write({ id: String(event.id), event: event.kind, data: event.data });
        };
        for (const event of this.since(c.req.header('Last-Event-ID'))) send(event);
        this.clients.add(send);

        // Something immediately, before the first heartbeat is due. A client cannot call
        // itself connected until a byte arrives, and on a quiet library the next one is
        // HEARTBEAT_MS away - so a reader who just launched waited twenty seconds to be told
        // the library was reachable, and every view holding a request that failed while it
        // was starting waited with them. Carries no data, so it dispatches no event: the
        // point is the flush.
        void write({ event: 'ping', data: '' });

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
  since(lastEventId: string | undefined): LibraryEvent[] {
    const last = Number(lastEventId);
    if (!Number.isInteger(last) || last <= 0 || last >= this.nextId) return [];
    return this.recent.filter((event) => event.id > last);
  }

  announce<K extends LibraryEventKind>(kind: K, payload: LibraryEventPayload<K>): void {
    const data = JSON.stringify(LibraryEventSchemas[kind].parse(payload));
    const event: LibraryEvent = { id: this.nextId++, kind, data };
    this.recent.push(event);
    if (this.recent.length > REPLAY) this.recent.shift();
    for (const send of this.clients) send(event);
  }
}
