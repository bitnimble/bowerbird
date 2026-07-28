import { eventsUrl } from '../../api/client';

export class EventsPresenter {
  private source: EventSource | null = null;
  // One entry per photo something on screen is watching, dropped as those views
  // go. Nothing accumulates: what is not being displayed cannot need telling.
  private readonly watchers = new Map<string, Set<() => void>>();

  // One stream for the session, opened by the shell. EventSource reconnects on
  // its own and replays what it missed through Last-Event-ID, so there is nothing
  // to retry here; a server that stays down leaves the views as they are, and the
  // backoff each of them falls back on (§18.6) covers what it never delivered.
  connect(): void {
    if (this.source != null) return;
    const source = new EventSource(eventsUrl());
    source.addEventListener('thumbnail', (event) => {
      for (const watcher of this.watchers.get((event as MessageEvent<string>).data) ?? []) watcher();
    });
    this.source = source;
  }

  disconnect(): void {
    this.source?.close();
    this.source = null;
  }

  /** Calls back when this photo's renditions are rewritten. Returns the unsubscribe. */
  watch(photoId: string, onRebuilt: () => void): () => void {
    const watchers = this.watchers.get(photoId) ?? new Set();
    watchers.add(onRebuilt);
    this.watchers.set(photoId, watchers);
    return () => {
      watchers.delete(onRebuilt);
      if (watchers.size === 0) this.watchers.delete(photoId);
    };
  }
}
