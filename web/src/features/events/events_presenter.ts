import { CompositeProgressSchema } from '../../../../src/schemas/composition';
import {
  RenditionEventSchema,
  RenditionFetchEventSchema,
  ReplicationEventSchema,
} from '../../../../src/schemas/events';
import { ExportProgressSchema } from '../../../../src/schemas/exports';
import { type EventStream, subscribeEvents } from '../../api/transport';
import type { ExportPresenter } from '../export/export_presenter';
import type { LabelsPresenter } from '../labels/labels_presenter';
import type { PhotosPresenter } from '../photos/photos_presenter';
import type { ReplicationPresenter } from '../replication/replication_presenter';
import type { StackTriagePresenter } from '../photos/stack_triage/stack_triage_presenter';
import type { BackupPresenter } from '../backup/backup_presenter';

export class EventsPresenter {
  private stream: EventStream | null = null;

  constructor(
    private readonly photos: Pick<
      PhotosPresenter,
      'serverReachable' | 'renditionsRebuilt' | 'renditionFetch' | 'compositeProgressed'
    >,
    private readonly replication: Pick<ReplicationPresenter, 'libraryChanged' | 'reload'>,
    private readonly stackTriage: Pick<StackTriagePresenter, 'renditionsRebuilt'>,
    private readonly exports: Pick<ExportPresenter, 'progressed'>,
    private readonly labels: Pick<LabelsPresenter, 'load'>,
    private readonly backup: Pick<BackupPresenter, 'load' | 'refresh' | 'dispose'>,
  ) {}

  // EventSource reconnects on its own and replays what it missed through Last-Event-ID, so
  // nothing retries here; the backoff a view falls back on (§18.6) covers the rest.
  connect(): void {
    if (this.stream != null) return;
    this.stream = subscribeEvents({
      // Every *re*connect, and not the baseline. What `serverReachable` does is invalidate
      // what the views are holding, so a server that went away and came back makes them ask
      // again - where against a stream that was already up when this subscribed nothing went
      // away and everything on screen was fetched moments ago, so it is a cache thrown away
      // for nothing.
      open: (reconnect) => {
        this.backup.refresh();
        if (!reconnect) return;
        this.photos.serverReachable();
        void this.replication.reload('background');
        void this.labels.load('background');
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
      rendition_fetch: (payload) => {
        const { id, rendition, phase } = RenditionFetchEventSchema.parse(JSON.parse(payload));
        this.photos.renditionFetch(id, rendition, phase);
      },
      replication: (payload) => {
        const { library_id } = ReplicationEventSchema.parse(JSON.parse(payload));
        void this.replication.libraryChanged(library_id);
        void this.labels.load('background');
      },
      backup: () => this.backup.refresh(),
      // A merge is minutes of work behind one request, so what the grid draws while it runs -
      // the frames dimmed, the bar in the toast - comes from here rather than from the call.
      composite: (payload) =>
        this.photos.compositeProgressed(CompositeProgressSchema.parse(JSON.parse(payload))),
      // A photograph is one request the client waits on, so how far into it the render has got
      // cannot come back in the answer: the file is the answer.
      export: (payload) => this.exports.progressed(ExportProgressSchema.parse(JSON.parse(payload))),
    });
    void this.backup.load();
  }

  disconnect(): void {
    this.stream?.close();
    this.stream = null;
    this.backup.dispose();
  }
}
