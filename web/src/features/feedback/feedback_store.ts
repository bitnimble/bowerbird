import { observable } from 'mobx';
import type { PhotoDetail } from '../../../../src/schemas/photos';

export class FeedbackStore {
  @observable accessor open = false;

  /**
   * The photograph the form was opened over, or null from anywhere that is not showing one.
   *
   * Its detail rather than its id: what the form has to decide is whether the original will
   * fit in a report, which is `file_size`, and whether there is a camera JPEG to attach.
   */
  @observable accessor photo: PhotoDetail | null = null;
}
