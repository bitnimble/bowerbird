import { action } from 'mobx';
import { eventsUrl } from '../../api/client';
import type { EventsStore } from './events_store';

export class EventsPresenter {
  private source: EventSource | null = null;

  constructor(private readonly store: EventsStore) {}

  // One stream for the session, opened by the shell. EventSource reconnects on
  // its own and replays what it missed through Last-Event-ID, so there is nothing
  // to retry here; a server that stays down just leaves the map as it is.
  connect(): void {
    if (this.source != null) return;
    const source = new EventSource(eventsUrl());
    source.addEventListener('thumbnail', (event) => this.rebuilt((event as MessageEvent<string>).data));
    this.source = source;
  }

  @action.bound
  private rebuilt(photoId: string): void {
    // Counted rather than stamped: all a version has to do is differ from the one
    // this client last put in a URL.
    this.store.versions.set(photoId, this.store.version(photoId) + 1);
  }

  disconnect(): void {
    this.source?.close();
    this.source = null;
  }
}
