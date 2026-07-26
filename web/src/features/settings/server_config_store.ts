import { observable } from 'mobx';

export interface ThumbnailProfile {
  size: number;
  quality: number;
}

export interface ServerConfig {
  thumbnails: {
    format: string;
    color_space: string;
    small: ThumbnailProfile;
    full: ThumbnailProfile;
  };
}

// Encoding settings only the server knows, so the photo view can state what the
// image on screen actually is rather than guessing.
export class ServerConfigStore {
  @observable.ref accessor config: ServerConfig | null = null;
}
