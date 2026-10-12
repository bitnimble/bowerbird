import { action } from 'mobx';
import type { DynamicRange } from '../api/transport';
import type { ScreenStore } from './screen_store';

const SCREEN_POLL_MS = 1000;
const HDR_QUERY = '(dynamic-range: high)';

export class ScreenPresenter {
  private asking = false;

  /** `read` is null in a browser, which has no shell to ask. */
  constructor(
    private readonly store: ScreenStore,
    private readonly read: (() => Promise<DynamicRange | null>) | null,
  ) {}

  /** Resolves once the shell has answered, or at once in a browser. */
  follow(): Promise<void> {
    const media = globalThis.matchMedia?.(HDR_QUERY);
    if (media != null) {
      this.setMediaHdr(media.matches);
      media.addEventListener('change', (event) => this.setMediaHdr(event.matches));
    }
    if (this.read == null) return Promise.resolve();
    // Polled: macOS announces neither a brightness change nor a move to another screen.
    setInterval(() => void this.ask(), SCREEN_POLL_MS);
    window.addEventListener('focus', () => void this.ask());
    return this.ask();
  }

  async ask(): Promise<void> {
    if (this.read == null || this.asking) return;
    // One at a time, so a slow answer never lands over a newer one.
    this.asking = true;
    try {
      this.setReading(await this.read());
    } catch {
      // A shell that cannot answer leaves the last reading, or the media query, standing.
    } finally {
      this.asking = false;
    }
  }

  @action.bound
  private setReading(reading: DynamicRange | null): void {
    this.store.reading = reading;
  }

  @action.bound
  private setMediaHdr(hdr: boolean): void {
    this.store.mediaHdr = hdr;
  }
}
