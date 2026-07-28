// Renditions are written by a background queue, so a view can ask for one before
// it exists and the server announces it a moment later (§18.6). Being told is the
// fast path; this backoff is the floor under it, for an announcement that never
// arrives - a stream that is down, one that connected a moment after the request,
// or a client asleep past the replay buffer. Shared so the grid tile and the
// viewer give up at the same point rather than drifting apart.
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
