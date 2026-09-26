import { ArrowLeft, Ban, Check, Columns2, Equal, RotateCcw, SquareStack } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import { usePresenters, useStackTriageStore } from '../../../app/stores_context';
import { Button, ButtonHint } from '../../../ui/button';
import { ICON } from '../../../ui/icon';
import { ShowSidebarButton } from '../../../ui/page';
import { DRAGS_WINDOW } from '../../../ui/title_bar';
import { Row } from '../../../ui/row';
import { SegmentedControl } from '../../../ui/segmented_control';
import { PhotoDetailStrings } from '../viewer/photo_detail_page.strings';
import { sideKeys, type Placed, type Verdict } from './stack_triage';
import { StackTriageStrings } from './stack_triage_page.strings';
import { styles } from './stack_triage_page.stylex';
import { TriageQueue } from './triage_queue';
import type { TriageMode } from './triage_storage';

interface Choice {
  verdict: Verdict;
  label: string;
  hint: string;
  danger?: boolean;
}

// Empty hints: the two picks are hinted with the arrow that matches how the pair
// is laid out (`sideKeys`), which is not knowable from here.
const PICKS: Choice[] = [
  { verdict: 'a', label: StackTriageStrings.pickA(), hint: '' },
  { verdict: 'b', label: StackTriageStrings.pickB(), hint: '' },
];

const BOTH: Choice = { verdict: 'both', label: StackTriageStrings.both(), hint: StackTriageStrings.bothKey() };

// Click-only: every key that could carry it is an arrow, and all four of these
// name a photograph rather than a fate.
const NEITHER: Choice = { verdict: 'neither', label: StackTriageStrings.neither(), hint: '', danger: true };

export const VERDICTS: Choice[] = [BOTH, ...PICKS, NEITHER];

// Which of `sideKeys` a screen is showing: the axis the two halves are actually
// laid out on, and the reading order everywhere else - flip draws one photograph
// at a time, so there is no axis to follow and A is simply the first.
export function drawnAxis(store: { mode: TriageMode; placement: Placed | null }): 'row' | 'column' {
  return store.mode === 'split' ? (store.placement?.direction ?? 'row') : 'row';
}

export function nameOf(photo: PhotoSummary): string {
  return photo.file_path?.split('/').pop() ?? photo.id;
}

// The grid rendition, which is what a band already draws: a contact-sheet row
// wants the thumbnail, where the session's own rendition is for judging.
const Verdicts = observer(function Verdicts({ ready }: { ready: boolean }): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage, toasts } = usePresenters();

  const cast = (verdict: Verdict): void => {
    const round = store.round;
    if (round == null) return;
    void stackTriage.judge(verdict).then(() => {
      if (verdict !== 'neither') return;
      // The entry this verdict made, not the position it made it at. A toast lives
      // twelve seconds and outlives the route: by the time it is pressed the
      // position may hold a different round, of a different stack.
      const entry = store.history[store.history.length - 1];
      if (entry == null) return;
      // Reported with an undo rather than confirmed first, matching the Bin: a
      // confirmation on a repeated action is worse than a way back from it.
      toasts.showUndoable(StackTriageStrings.bothRejected(), PhotoDetailStrings.undo(), () =>
        stackTriage.rewindToEntry(entry),
      );
    });
  };

  const keys = sideKeys(drawnAxis(store));

  const button = ({ verdict, label, hint, danger }: Choice): JSX.Element => {
    const side = verdict === 'a' || verdict === 'b';
    const key = verdict === 'a' ? keys[0] : verdict === 'b' ? keys[1] : hint;
    return (
      <Button
        key={verdict}
        style={side ? (verdict === 'a' ? styles.markA : styles.markB) : undefined}
        variant={danger === true ? 'danger' : 'default'}
        disabled={!ready || store.busy}
        onClick={() => cast(verdict)}
      >
        {verdict === 'both' ? <Equal size={ICON} /> : verdict === 'neither' ? <Ban size={ICON} /> : null}
        {label}
        {key !== '' && (
          <ButtonHint style={side ? (verdict === 'a' ? styles.hintA : styles.hintB) : undefined}>{key}</ButtonHint>
        )}
      </Button>
    );
  };

  // Three groups rather than four buttons in a row: the flanks are what the grid
  // gives equal width, which is what centres the picks rather than the set of
  // four. Flattened, the picks sit off the photograph's centre line.
  return (
    <Row style={styles.verdicts}>
      <Row style={styles.flankFirst}>{button(BOTH)}</Row>
      <Row>{PICKS.map(button)}</Row>
      <Row>{button(NEITHER)}</Row>
    </Row>
  );
});

export const Header = observer(function Header({ onLeave, ready }: { onLeave: () => void; ready: boolean }): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();
  const running = store.status === 'running';

  return (
    <Row {...DRAGS_WINDOW} style={styles.bar}>
      <ShowSidebarButton />
      <Row style={styles.barEnd}>
        <Button onClick={onLeave}>
          <ArrowLeft size={ICON} />
          {StackTriageStrings.back()}
        </Button>
        {running && (
          <>
            <Button disabled={store.history.length === 0 || store.busy} onClick={() => void stackTriage.undo()}>
              <RotateCcw size={ICON} />
              {PhotoDetailStrings.undo()}
              <ButtonHint>{StackTriageStrings.keysUndo()}</ButtonHint>
            </Button>
            <Button disabled={store.busy} onClick={() => void stackTriage.keepTheRest()}>
              <Check size={ICON} />
              {StackTriageStrings.keepTheRest()}
            </Button>
          </>
        )}
      </Row>

      {running && <Verdicts ready={ready} />}

      <Row style={[styles.barEnd, styles.barLast]}>
        {/* Both presentations named and one of them pressed, as the gallery names
            its own views: a single button labelled with the mode it is already in
            cannot say whether it reports the state or changes it. */}
        {running && (
          <SegmentedControl
            label={StackTriageStrings.presentation()}
            value={store.mode}
            onChange={stackTriage.setMode}
            options={[
              { value: 'flip', label: StackTriageStrings.flip(), icon: <SquareStack size={ICON} />, hint: 'V' },
              { value: 'split', label: StackTriageStrings.split(), icon: <Columns2 size={ICON} /> },
            ]}
          />
        )}
        <TriageQueue choices={VERDICTS} />
      </Row>
    </Row>
  );
});

