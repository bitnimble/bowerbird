import type { MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { AppError } from '../errors';

export function requireToken(token: string): MiddlewareHandler {
  const expected = Buffer.from(`Bearer ${token}`);
  return async (c, next) => {
    const given = Buffer.from(c.req.header('authorization') ?? '');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AppError('UNAUTHORIZED', 'this server only answers the app that started it');
    }
    await next();
  };
}
