import { eventsUrl } from '../../api/client';
import type { PhotosPresenter } from '../photos/photos_presenter';

export class EventsPresenter {
  private source: EventSource | null = null;

  constructor(private readonly photos: PhotosPresenter) {}

  // One stream for the session, opened by the shell. EventSource reconnects on
  // its own and replays what it missed through Last-Event-ID, so there is nothing
  // to retry here; a server that stays down leaves the rows as they are, and the
  // backoff a view falls back on (§18.6) covers what was never delivered.
  connect(): void {
    if (this.source != null) return;
    const source = new EventSource(eventsUrl());
    source.addEventListener('thumbnail', (event) => {
      // The announcement carries the row's new value rather than a bare "it
      // changed", so nothing has to be re-read to act on it.
      const { id, version } = JSON.parse((event as MessageEvent<string>).data) as { id: string; version: string };
      this.photos.renditionsRebuilt(id, version);
    });
    this.source = source;
  }

  disconnect(): void {
    this.source?.close();
    this.source = null;
  }
}
