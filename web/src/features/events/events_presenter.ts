import { CompositeProgressSchema } from '../../../../src/schemas/composition';
import { RenditionEventSchema, ReplicationEventSchema } from '../../../../src/schemas/events';
import { ExportProgressSchema } from '../../../../src/schemas/exports';
import { type EventStream, subscribeEvents } from '../../api/transport';
import type { ExportPresenter } from '../export/export_presenter';
import type { PhotosPresenter } from '../photos/photos_presenter';
import type { ReplicationPresenter } from '../replication/replication_presenter';
import type { StackTriagePresenter } from '../photos/stack_triage/stack_triage_presenter';

export class EventsPresenter {
  private stream: EventStream | null = null;

  constructor(
    private readonly photos: PhotosPresenter,
    private readonly replication: Pick<ReplicationPresenter, 'libraryChanged' | 'reload'>,
    private readonly stackTriage: Pick<StackTriagePresenter, 'renditionsRebuilt'>,
    private readonly exports: Pick<ExportPresenter, 'progressed'>,
  ) {}

  // One stream for the session, opened by the shell. Whichever transport carries it
  // reconnects on its own and replays what it missed through Last-Event-ID, so there is
  // nothing to retry here; a server that stays down leaves the rows as they are, and the
  // backoff a view falls back on (§18.6) covers what was never delivered.
  connect(): void {
    if (this.stream != null) return;
    this.stream = subscribeEvents({
      // Every *re*connect, and not the baseline. What `serverReachable` does is invalidate
      // what the views are holding, so a server that went away and came back makes them ask
      // again - where against a stream that was already up when this subscribed nothing went
      // away and everything on screen was fetched moments ago, so it is a cache thrown away
      // for nothing.
      //
      // Which of the two it is comes from the transport rather than from a counter here. A
      // count says "not the first", and the first is the meaningful one in the shell: the
      // page renders from its embedded bundle against a library that is not running, and the
      // connect that follows is exactly the news these views are waiting for.
      open: (reconnect) => {
        if (!reconnect) return;
        this.photos.serverReachable();
        void this.replication.reload('background');
      },
      rendition: (payload) => {
        // The announcement carries the row's new value rather than a bare "it changed", so
        // nothing has to be re-read to act on it.
        const { id, stage, version } = RenditionEventSchema.parse(JSON.parse(payload));
        this.photos.renditionsRebuilt(id, stage, version);
        // A triage session's members are its own rows, held nowhere else: without this a
        // rebuild announced mid-session leaves both sides of every round drawn from the
        // file that was just replaced, which is the one thing a cull is judging.
        this.stackTriage.renditionsRebuilt(id, stage, version);
      },
      replication: (payload) => {
        const { library_id } = ReplicationEventSchema.parse(JSON.parse(payload));
        void this.replication.libraryChanged(library_id);
      },
      // A merge is minutes of work behind one request, so what the grid draws while it runs -
      // the frames dimmed, the bar in the toast - comes from here rather than from the call.
      composite: (payload) => this.composited(payload),
      // A photograph is one request the client waits on, so how far into it the render has got
      // cannot come back in the answer: the file is the answer.
      export: (payload) => this.exports.progressed(ExportProgressSchema.parse(JSON.parse(payload))),
    });
  }

  composited(payload: string): void {
    this.photos.compositeProgressed(CompositeProgressSchema.parse(JSON.parse(payload)));
  }

  disconnect(): void {
    this.stream?.close();
    this.stream = null;
  }
}
