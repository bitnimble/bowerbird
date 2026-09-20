import { z } from 'zod';
import { AppError } from '../errors';

/** A handler's answer, through the schema the client parses it with. */
export function respond<S extends z.ZodType>(schema: S, value: z.input<S>): z.output<S> {
  const parsed = schema.safeParse(value);
  // A response that fails its own schema is this server's bug, not the caller's 400.
  if (!parsed.success) throw new AppError('INTERNAL_ERROR', `response failed its schema: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
