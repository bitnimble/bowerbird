import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors';

// Central error -> HTTP envelope mapping (DESIGN §14). Shared by the server and
// API tests so both exercise the same behavior.
export function applyErrorHandler(app: Hono): void {
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message } }, err.status);
    }
    if (err instanceof z.ZodError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: err.issues } }, 400);
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON body' } }, 400);
    }
    console.error(err);
    return c.json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } }, 500);
  });
}
