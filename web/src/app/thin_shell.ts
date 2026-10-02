import { inMobileApp } from '../api/transport';

/**
 * Whether this device only holds libraries synced from another Bowerbird: it keeps no RAWs and
 * imports none, fetching an original at a time to edit and syncing triage back. Settings for a
 * library's folders, scanning, stacks and backups have nothing to act on here.
 */
export function isThinShell(): boolean {
  return inMobileApp();
}
