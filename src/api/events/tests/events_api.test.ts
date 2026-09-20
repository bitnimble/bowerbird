import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { PathSegment, route } from '../../../schemas/route';
import type { ProcessingService } from '../../../services/processing/pipeline/processing_service';
import type { ProcessingStage } from '../../../schemas/common';
import type { RenditionWritten } from '../../../services/processing/workers/processing_types';
import { EventsApi } from '../events_api';

function build() {
  let notify: (photoId: string, written: RenditionWritten) => void = () => {};
  const processing = {
    onProcessed: (listener: (photoId: string, written: RenditionWritten) => void) => {
      notify = listener;
    },
  } as unknown as ProcessingService;

  const api = new EventsApi(processing);
  const app = new Hono();
  app.route(route(PathSegment.api(), PathSegment.events()), api.routes);
  return {
    api,
    app,
    processed: (photoId: string, stage: ProcessingStage = 'tile', version = '2026-07-28T00:00:00.000Z') =>
      notify(photoId, { stage, version }),
  };
}

async function readChunk(reader: { read(): Promise<{ value?: Uint8Array }> }): Promise<string> {
  const { value } = await reader.read();
  return new TextDecoder().decode(value);
}

describe('EventsApi', () => {
  // A byte the moment the stream opens, which is what lets a client say it is connected.
  // Without it the next one is a heartbeat away: a shell that waits for the first byte
  // before reporting the library reachable waited twenty seconds to do it, and every view
  // holding a request that failed while it started waited with it.
  it('writes something immediately, before any event or heartbeat', async () => {
    const { app } = build();
    const res = await app.request(route(PathSegment.api(), PathSegment.events()));
    const reader = res.body!.getReader();

    const opening = await readChunk(reader);
    // No data, so it dispatches no event on any client - the point is the flush.
    expect(opening).toBe('event: ping\ndata: \n\n');
    await reader.cancel();
  });

  it('streams a processed photo to a connected client', async () => {
    const { app, processed } = build();
    const res = await app.request(route(PathSegment.api(), PathSegment.events()));
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    await readChunk(reader);
    processed('photo-a');
    // The exact wire format, because an EventSource that cannot parse it reports
    // nothing at all rather than failing.
    expect(await readChunk(reader)).toBe(
      'event: rendition\ndata: {"id":"photo-a","stage":"tile","version":"2026-07-28T00:00:00.000Z"}\nid: 1\n\n',
    );
    await reader.cancel();
  });

  // The sidebar learns of a session it never asked for over the same stream, and a
  // client that knows only renditions has to keep parsing the ones it does know.
  it('carries a second kind of announcement on the same stream', async () => {
    const { app, api } = build();
    const res = await app.request(route(PathSegment.api(), PathSegment.events()));
    const reader = res.body!.getReader();
    await readChunk(reader);

    api.announce('replication', { library_id: 'lib' });

    expect(await readChunk(reader)).toBe('event: replication\ndata: {"library_id":"lib"}\nid: 1\n\n');
    await reader.cancel();
  });

  it('replays what a reconnecting client missed, and nothing it already saw', async () => {
    const { app, api, processed } = build();
    processed('photo-a');
    processed('photo-b');
    processed('photo-c');

    expect(api.since('1').map((e) => e.data)).toEqual([
      '{"id":"photo-b","stage":"tile","version":"2026-07-28T00:00:00.000Z"}',
      '{"id":"photo-c","stage":"tile","version":"2026-07-28T00:00:00.000Z"}',
    ]);
    expect(api.since('3')).toEqual([]);

    const res = await app.request(route(PathSegment.api(), PathSegment.events()), { headers: { 'Last-Event-ID': '2' } });
    const reader = res.body!.getReader();
    expect(await readChunk(reader)).toContain('"id":"photo-c"');
    await reader.cancel();
  });

  it('replays nothing for an id this process never issued', () => {
    const { api, processed } = build();
    processed('photo-a');

    // A restart: the client's id belongs to the previous run's numbering, so
    // "everything after 40" would be the whole buffer, most of it already seen.
    expect(api.since('41')).toEqual([]);
    expect(api.since(undefined)).toEqual([]);
    expect(api.since('nonsense')).toEqual([]);
  });
});
