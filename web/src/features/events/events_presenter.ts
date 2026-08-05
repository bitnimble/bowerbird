import type { ProcessingStage } from '../../api/client';
import { type EventStream, subscribeEvents } from '../../api/transport';
import type { PhotosPresenter } from '../photos/photos_presenter';

export class EventsPresenter {
  private stream: EventStream | null = null;

  constructor(private readonly photos: PhotosPresenter) {}

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
        if (reconnect) this.photos.serverReachable();
      },
      rendition: (payload) => {
        // The announcement carries the row's new value rather than a bare "it changed", so
        // nothing has to be re-read to act on it.
        const { id, stage, version } = JSON.parse(payload) as {
          id: string;
          stage: ProcessingStage;
          version: string;
        };
        this.photos.renditionsRebuilt(id, stage, version);
      },
    });
  }

  disconnect(): void {
    this.stream?.close();
    this.stream = null;
  }
}
