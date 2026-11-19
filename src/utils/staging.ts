import path from 'node:path';
import { newId } from '../schemas/id';

export const STAGING_SUFFIX = '.tmp';
const STAGED_NAME = new RegExp(`^(.+)\\.[0-9a-z]{16}${STAGING_SUFFIX.replaceAll('.', '\\.')}$`);

/** Where to stage `final`; the prune sweep spares it while young. */
export function stagingPathFor(final: string): string {
  return `${final}.${newId()}${STAGING_SUFFIX}`;
}

/** The filename `stagingPathFor` staged, or null when `staging` isn't one of its paths. */
export function stagedName(staging: string): string | null {
  return STAGED_NAME.exec(path.basename(staging))?.[1] ?? null;
}
