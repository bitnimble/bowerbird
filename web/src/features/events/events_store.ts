import { observable } from 'mobx';

export class EventsStore {
  // How many times this client has learned that a photo's renditions were
  // rewritten, keyed by photo id: from the server's announcement, or from a
  // rebuild it asked for itself. An ObservableMap rather than an object or one
  // shared counter, because it tracks reads per key - a tile or a viewer watching
  // its own photo is not woken by another photo's rebuild.
  //
  // Per photo rather than per rendition, because the viewer warms its neighbours
  // and has no detail for them: one version per photo is the same whether a frame
  // is being warmed or shown, so the warmed URL is the one that ends up on screen.
  @observable accessor versions = new Map<string, number>();

  // 0 until something says otherwise, which `renditionUrl` leaves out of the URL
  // entirely: a photo asks for the plain path until it is known to have moved.
  version(photoId: string): number {
    return this.versions.get(photoId) ?? 0;
  }
}
