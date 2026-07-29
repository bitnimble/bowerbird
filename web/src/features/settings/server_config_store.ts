import { observable } from 'mobx';

export interface RenditionProfile {
  size: number;
  quality: number;
}

export interface ServerConfig {
  renditions: {
    format: string;
    color_space: string;
    grid: RenditionProfile;
    full: RenditionProfile;
  };
}

// Encoding settings only the server knows, so the photo view can state what the
// image on screen actually is rather than guessing, plus the user-editable
// preferences that live server-side because processing reads them.
export class ServerConfigStore {
  @observable.ref accessor config: ServerConfig | null = null;
}
