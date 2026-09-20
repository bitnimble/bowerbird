import { type LibraryScanStatus } from '../../../../src/schemas/libraries';
import type { ScanCounting } from './scan_store';

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
};
