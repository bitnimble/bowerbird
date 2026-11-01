import { answerHeaderRequest, type HeaderReply, type HeaderRequest } from './metadata';

// Bun worker thread: the header read of one file, or the lift of its embedded JPEG, off the main
// thread.
//
// A thread rather than a promise because `bb_read_header` and `bb_extract_embedded` are synchronous
// FFI calls (§10.4). Awaiting several of them on one thread interleaves only the EXIF zone read
// after each - the native read itself holds the thread, and on a library over a network mount or a
// card that read is a round trip per page.

declare const self: {
  onmessage: ((event: MessageEvent<HeaderRequest>) => void) | null;
  postMessage: (message: HeaderReply) => void;
};

self.onmessage = async (event) => {
  try {
    self.postMessage(await answerHeaderRequest(event.data));
  } catch (err) {
    // Reported rather than thrown, where a throw would take the worker with it.
    self.postMessage({ error: (err as Error).message });
  }
};
