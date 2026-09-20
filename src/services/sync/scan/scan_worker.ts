import { extractMetadata, type FileMetadata, type TileStage } from '../../processing/analysis/metadata';

// Bun worker thread: the header read of one file, off the main thread - and its grid
// tile, where the scan was given somewhere to put one (§10.4).
//
// A thread rather than a promise because `bb_read_header` is a synchronous FFI call
// (§10.4). Awaiting several of them on one thread interleaves the `stat` either side
// and nothing else - the read itself holds the thread, and on a library over a network
// mount that read is very nearly the whole cost of a scan.

export interface ScanRequest {
  absPath: string;
  stage?: TileStage;
}

export type ScanReply = { metadata: FileMetadata } | { error: string };

declare const self: {
  onmessage: ((event: MessageEvent<ScanRequest>) => void) | null;
  postMessage: (message: ScanReply) => void;
};

self.onmessage = async (event) => {
  try {
    self.postMessage({ metadata: await extractMetadata(event.data.absPath, event.data.stage) });
  } catch (err) {
    // Reported rather than thrown: an unreadable file leaves its row as it is and the
    // scan carries on (§9.1), where a throw would take the worker with it.
    self.postMessage({ error: (err as Error).message });
  }
};
