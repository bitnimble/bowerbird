import type { Hono } from 'hono';
import { z } from 'zod';
import { AppError } from '../errors';

// Central error -> HTTP envelope mapping (DESIGN §14). Shared by the server and
// API tests so both exercise the same behavior.
export function applyErrorHandler(app: Hono): void {
  // Unmatched route / method -> the same JSON envelope, not Hono's plain-text 404.
  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'not found' } }, 404));

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
    // The real message, not a placeholder. This is a single-user server run
    // against the operator's own library; "Unexpected error" tells them nothing
    // and leaves no string to search the log for.
    return c.json({ error: { code: 'INTERNAL_ERROR', message: (err as Error).message || 'Unexpected error' } }, 500);
  });
}
