import path from 'node:path';
import { newId } from '../schemas/id';

export const STAGING_SUFFIX = '.tmp';

/** Where to stage `final`; the prune sweep spares it while young. */
export function stagingPathFor(final: string): string {
  return `${final}.${newId()}${STAGING_SUFFIX}`;
}

/** The filename `stagingPathFor` staged, or null when `staging` isn't one of its paths. */
export function stagedName(staging: string): string | null {
  return /^(.+)\.[0-9a-z]{16}\.tmp$/.exec(path.basename(staging))?.[1] ?? null;
}
