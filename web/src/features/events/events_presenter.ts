import { action } from 'mobx';
import { eventsUrl } from '../../api/client';
import type { EventsStore } from './events_store';

// How many photos' versions to keep. An import announces every photo it touches,
// so a catalogue-sized run would otherwise leave an entry per photo for the life
// of the tab. Dropping the oldest is safe rather than merely tolerable: the
// version exists only to stop the browser reusing an <img> src it has already
// decoded, so a photo that loses one simply asks for the plain URL again and
// revalidates against the ETag (§13.5). Well past a page of tiles either way.
const REMEMBERED = 2000;

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
    // Insertion order, so this is the photo least recently *first* announced -
    // which during an import is the one furthest from anything still on screen.
    while (this.store.versions.size > REMEMBERED) {
      const oldest = this.store.versions.keys().next().value;
      if (oldest == null) break;
      this.store.versions.delete(oldest);
    }
  }

  disconnect(): void {
    this.source?.close();
    this.source = null;
  }
}
