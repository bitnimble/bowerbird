import { computed, observable } from 'mobx';
import { type ReleaseNote, type UpdateStatus } from '../../../../src/schemas/updates';

// What the install is, and what it could be. One observable for the whole answer rather
// than a field each: it arrives from the server as one object, and the sidebar's badge and
// the dialog behind it read the same one.
export class UpdatesStore {
  @observable.ref accessor status: UpdateStatus | null = null;
  @observable accessor dialogOpen = false;
  /**
   * Whether a check this page asked for is still in flight.
   *
   * Held here rather than read off the answer: the server finishes the check before it
   * replies, so by the time a status arrives it has never once been in the middle of one.
   */
  @observable accessor checking = false;
  /** From the moment the button is pressed until the new version is answering. */
  @observable accessor installing = false;
  @observable.ref accessor failure: string | null = null;

  @computed get current(): string | null {
    return this.status?.current ?? null;
  }

  /** Newest first, and only what is newer than this install: the dialog is cumulative. */
  @computed get newer(): readonly ReleaseNote[] {
    return this.status?.newer ?? [];
  }

  @computed get available(): ReleaseNote | null {
    return this.newer[0] ?? null;
  }

  /** Whether this install can replace itself, as opposed to pointing at a download. */
  @computed get canInstall(): boolean {
    return this.status?.can_install ?? false;
  }

  @computed get installHint(): string | null {
    return this.status?.install_hint ?? null;
  }
}
