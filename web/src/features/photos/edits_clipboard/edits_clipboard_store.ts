import { observable } from 'mobx';
import type { EditDoc } from '../../../../../src/schemas/photo_edits';

export class EditsClipboardStore {
  @observable.ref accessor copied: Partial<EditDoc> | null = null;
}
