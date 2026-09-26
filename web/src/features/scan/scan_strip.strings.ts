import { type LibraryScanStatus } from '../../../../src/schemas/libraries';
import type { ScanCounting } from './scan_store';

function originals(count: number): string {
  return `${count} ${count === 1 ? 'original' : 'originals'}`;
}

export const ScanStripStrings = {
  status: (status: LibraryScanStatus['status']) =>
    status === 'processing' ? 'processing'
    : status === 'rendition' ? 'rendition'
    : 'idle',
  noun: (counting: ScanCounting) => (counting === 'files' ? 'files' : 'renditions'),
  cellsLabel: (done: number, total: number, counting: ScanCounting) =>
    `${done} of ${total} ${ScanStripStrings.noun(counting)}`,
  count: (done: number, total: number, counting: ScanCounting) =>
    ` · ${done}/${total} ${ScanStripStrings.noun(counting)}`,
  rate: (perSecond: string, counting: ScanCounting) => ` · ${perSecond} ${ScanStripStrings.noun(counting)}/s`,
  eta: (duration: string) => ` · about ${duration} left`,
  outstanding: (count: number) => ` · ${count} renditions outstanding`,
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
