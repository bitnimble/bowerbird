import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Application error taxonomy. Services throw AppError with one of these codes;
// the API layer maps code -> HTTP status and the standard envelope (DESIGN §14).
export type ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  // The library forbids the write this needed. Distinct from VALIDATION_ERROR
  // because the request is well-formed and would have succeeded against another
  // library (§14).
  | 'READ_ONLY'
  | 'IO_ERROR'
  | 'SYNC_IN_PROGRESS'
  // This machine's clock leads the catalogue's own by more than replication
  // tolerates, so nothing may be stamped until the system time is fixed (§2.2 of
  // docs/replication.md).
  | 'CLOCK_SKEW'
  // The thing asked for is somewhere this device cannot read at the moment - an original on a
  // backup drive nobody has plugged in (§14.4). Not NOT_FOUND: the file exists, and the answer
  // changes when the drive does, so a client says "plug it in" rather than "it is gone".
  | 'UNAVAILABLE'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  READ_ONLY: 403,
  IO_ERROR: 500,
  SYNC_IN_PROGRESS: 409,
  CLOCK_SKEW: 500,
  UNAVAILABLE: 503,
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
