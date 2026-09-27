import { type LibraryScanStatus } from '../../../../src/schemas/libraries';
import type { ScanCounting } from './scan_store';

function originals(count: number): string {
  return `${count} ${count === 1 ? 'original' : 'originals'}`;
}

export const ScanStripStrings = {
  /** `counted` is whether the walk has found the files it is going to read yet. */
  phase: (status: LibraryScanStatus['status'], counted: boolean) =>
    status === 'rendition' ? 'building thumbnails and renditions'
    : counted ? 'reading files for changes'
    : 'looking for files',
  stopping: () => 'stopping after the current batch',
  noun: (counting: ScanCounting) => (counting === 'files' ? 'files' : 'renditions'),
  cellsLabel: (done: number, total: number, counting: ScanCounting) =>
    `${done} of ${total} ${ScanStripStrings.noun(counting)}`,
  count: (done: number, total: number, counting: ScanCounting) =>
    ` · ${done}/${total} ${ScanStripStrings.noun(counting)}`,
  rate: (perSecond: string, counting: ScanCounting) => ` · ${perSecond} ${ScanStripStrings.noun(counting)}/s`,
  eta: (duration: string) => ` · about ${duration} left`,
  scanned: (count: number) => ` · ${count} scanned`,
  added: (count: number) => ` · +${count}`,
  moved: (count: number) => ` · ${count} moved`,
  missing: (count: number) => ` · ${count} missing`,

  syncing: () => 'syncing',
  fetching: (count: number) => `fetching ${originals(count)}`,
  fetchingFromBackup: () => 'fetching originals from the backup',
  sending: (count: number) => `sending ${originals(count)}`,
  backingUp: (count: number) => `backing up ${originals(count)}`,
  backingUpNow: () => 'backing up',
  /** `continues` where it follows the scan's own words. */
  moving: (parts: string[], continues: boolean) => `${continues ? ' · ' : ''}${parts.join(' · ')}`,
};
