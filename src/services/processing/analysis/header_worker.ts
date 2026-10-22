import { extractMetadata, type HeaderMetadata } from './metadata';

// Bun worker thread: the header read of one file, off the main thread.
//
// A thread rather than a promise because `bb_read_header` is a synchronous FFI call
// (§10.4). Awaiting several of them on one thread interleaves only the EXIF zone read
// after each - the header read itself holds the thread, and on a library over a network
// mount that read is a round trip per page.

export interface HeaderRequest {
  absPath: string;
}

export type HeaderReply = { metadata: HeaderMetadata } | { error: string };

declare const self: {
  onmessage: ((event: MessageEvent<HeaderRequest>) => void) | null;
  postMessage: (message: HeaderReply) => void;
};

self.onmessage = async (event) => {
  try {
    self.postMessage({ metadata: await extractMetadata(event.data.absPath) });
  } catch (err) {
    // Reported rather than thrown, where a throw would take the worker with it.
    self.postMessage({ error: (err as Error).message });
  }
};
