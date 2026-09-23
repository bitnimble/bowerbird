import { observable } from 'mobx';
import type { FrameTv } from '../../../../src/schemas/frame_tv';

/** The Samsung Frame TVs the server last found on its network. */
export class FrameTvStore {
  @observable.ref accessor tvs: FrameTv[] = [];
  @observable accessor searching = false;

  nameOf(tvId: string): string {
    return this.tvs.find((tv) => tv.id === tvId)?.name ?? tvId;
  }
}
