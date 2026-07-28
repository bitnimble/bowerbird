import { eventsUrl } from '../../api/client';

// How many photos nothing is watching to keep a version for. Only the ones on
// screen have to be remembered exactly (see `remember`); this is the tail behind
// them, so that a neighbour warmed a moment ago is still at the version it was
// warmed at. Photos being watched are never evicted, so the real bound is this
// plus whatever is mounted.
const REMEMBERED = 512;

export class EventsPresenter {
  private source: EventSource | null = null;
  // One entry per photo something on screen is watching, dropped as those views
  // go, so nothing accumulates from views that have closed.
  private readonly watchers = new Map<string, Set<() => void>>();
  // What to put in a photo's rendition URLs. Shared rather than held by each
  // view, because the viewer warms its neighbours: the URL a frame is warmed at
  // has to be the URL it is painted at when the reader steps onto it, and per-view
  // state cannot do that - the subscription that knew the version is torn down in
  // the same commit that starts the one that needs it. Painting the plain URL
  // instead is not merely a wasted warm: the browser answers it from the copy it
  // already has, which is the file from before the rebuild.
  private readonly versions = new Map<string, number>();

  // One stream for the session, opened by the shell. EventSource reconnects on
  // its own and replays what it missed through Last-Event-ID, so there is nothing
  // to retry here; a server that stays down leaves the views as they are, and the
  // backoff each of them falls back on (§18.6) covers what it never delivered.
  connect(): void {
    if (this.source != null) return;
    const source = new EventSource(eventsUrl());
    source.addEventListener('thumbnail', (event) => this.rebuilt((event as MessageEvent<string>).data));
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

  /** 0 until this photo is known to have been rebuilt, which leaves its URLs plain. */
  versionOf(photoId: string): number {
    return this.versions.get(photoId) ?? 0;
  }

  private rebuilt(photoId: string): void {
    // A moment, because all it has to do is differ from the last one this client
    // put in a URL for this photo.
    this.remember(photoId, Date.now());
    for (const watcher of this.watchers.get(photoId) ?? []) watcher();
  }

  private remember(photoId: string, version: number): void {
    this.versions.set(photoId, version);
    // Oldest first, and never one being watched: dropping a version returns that
    // photo to its plain URL, which is right for one nobody is looking at (the
    // ETag settles it on the next request) and wrong for one on screen, whose
    // URL would move back to the copy the browser is already holding.
    for (const id of this.versions.keys()) {
      if (this.versions.size <= REMEMBERED) break;
      if (!this.watchers.has(id)) this.versions.delete(id);
    }
  }
}
