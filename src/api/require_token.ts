import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors';

/** The query parameter the desktop app opens its window with (`src-tauri/src/server.rs`). */
export const SIGN_IN_PARAM = 'token';

/**
 * Answers only the app that started this server.
 *
 * Its own requests carry the token as a bearer. The page it opens cannot put a header on an
 * `<img>` or an `EventSource`, so it opens `/?token=…` once and carries a cookie from then on.
 */
export function requireToken(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === 'GET' && same(c.req.query(SIGN_IN_PARAM), token)) {
      setCookie(c, cookieName(c), token, { httpOnly: true, sameSite: 'Strict', path: '/' });
      const url = new URL(c.req.url);
      url.searchParams.delete(SIGN_IN_PARAM);
      c.header('Cache-Control', 'no-store');
      return c.redirect(url.href);
    }
    const bearer = c.req.header('authorization')?.match(/^Bearer (.*)$/)?.[1];
    if (same(bearer, token) || same(getCookie(c, cookieName(c)), token)) {
      await next();
      return;
    }
    throw new AppError('UNAUTHORIZED', 'this server only answers the app that started it');
  };
}

/** Per port, because a cookie is per host: a second server on this machine would otherwise overwrite it. */
function cookieName(c: Context): string {
  return `bowerbird_token_${new URL(c.req.url).port}`;
}

function same(given: string | undefined, expected: string): boolean {
  if (given == null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
