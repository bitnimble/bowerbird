import { observable } from 'mobx';
import { type ExportRun } from '../../../../src/schemas/exports';

/**
 * What has been exported, newest run first (§10.5.1).
 *
 * The runs as the server grouped them: a run of one photograph and a run of a thousand are
 * the same shape, and which one a reader is looking at is a count rather than a kind.
 */
export class ExportHistoryStore {
  @observable.ref accessor runs: ExportRun[] = [];
  @observable accessor loading = false;
  @observable accessor error: string | null = null;
}
