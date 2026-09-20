import type { Context } from 'hono';

/**
 * Lifts the idle timeout for a request that is one long wait by design.
 *
 * Bun closes an idle request at `IDLE_TIMEOUT_SECONDS` (255 is its ceiling, and
 * `index.ts` sets it there). Some requests here answer only when minutes of work
 * have finished - a library's first scan opens and hashes every file, and a
 * replica's first session takes a whole catalogue - and what the reader sees when
 * the socket is closed underneath one is not a timeout, it is a request that
 * failed. The work carries on server-side, so the UI reports an error for
 * something that is still running and will succeed.
 *
 * Absent outside a Bun server (the tests mount these routes on their own Hono),
 * where there is no timeout to lift.
 */
export function takeAsLongAsItTakes(c: Context): void {
  const server = (c.env as { server?: { timeout: (request: Request, seconds: number) => void } } | undefined)?.server;
  server?.timeout(c.req.raw, 0);
}
