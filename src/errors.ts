import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Application error taxonomy. Services throw AppError with one of these codes;
// the API layer maps code -> HTTP status and the standard envelope (DESIGN §14).
export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'IO_ERROR'
  | 'SYNC_IN_PROGRESS'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  IO_ERROR: 500,
  SYNC_IN_PROGRESS: 409,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get status(): ContentfulStatusCode {
    return STATUS[this.code];
  }
}
