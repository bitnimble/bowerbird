import * as stylex from '@stylexjs/stylex';
import { ListOrdered } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import { renditionsApi } from '../../../api/renditions';
import { usePresenters, useStackTriageStore } from '../../../app/stores_context';
import { focusRing } from '../../../ui/focus_ring';
import { ICON } from '../../../ui/icon';
import { PopoverButton } from '../../../ui/popover_button';
import { Text } from '../../../ui/text';
import { color, size } from '../../../ui/tokens.stylex';
import { renditionVersion } from '../photos_store';
import { pairKey, type Round, type Verdict } from './stack_triage';
import { StackTriageStrings } from './stack_triage_page.strings';

const styles = stylex.create({
  queue: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    minWidth: '220px',
    maxHeight: '60vh',
    overflow: 'auto',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '4px',
    borderWidth: 0,
    borderRadius: size.radius,
    backgroundColor: { default: 'transparent', ':hover': color.slateSoft },
    color: 'inherit',
    cursor: 'pointer',
    textAlign: 'left',
  },
  inert: {
    cursor: 'default',
    opacity: 0.6,
    backgroundColor: 'transparent',
  },
  thumbnail: {
    width: '34px',
    height: '34px',
    objectFit: 'cover',
    borderRadius: '2px',
  },
});

// The grid rendition, which is what a band already draws: a contact-sheet row
// wants the thumbnail, where the session's own rendition is for judging.
function thumbnail(photo: PhotoSummary): string {
  return renditionsApi.url(photo.id, 'grid', renditionVersion(photo, 'grid'));
}

// The rounds already judged and the ones still projected. Selecting a completed
// round rewinds to it, which is the same operation undo performs, offered by name
// rather than by depth.
export const TriageQueue = observer(function TriageQueue({
  choices,
}: {
  choices: readonly { verdict: Verdict; label: string }[];
}): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();
  const roundOf = (round: Round): [PhotoSummary | undefined, PhotoSummary | undefined] => [
    store.members.get(round.a),
    store.members.get(round.b),
  ];

  return (
    <PopoverButton
      trigger={
        <>
          <ListOrdered size={ICON} />
          {StackTriageStrings.queue()}
          {/* One element, brackets and all: the button lays its children out in a
              row with a gap, so a bare number between two text nodes comes out as
              `Queue ( 4 )`. */}
          <span>{StackTriageStrings.queueLeft(store.pool.length)}</span>
        </>
      }
    >
      <div {...stylex.props(styles.queue)}>
        {/* An upper bound that only falls, so it is labelled as one: a draw lowers
            it while the pool stays the same size, which would otherwise read as a
            counter that had stalled. */}
        <Text variant="mono">
          {StackTriageStrings.queueCount(store.pool.length, store.members.size, store.remaining)}
        </Text>

        <Text variant="label" as="div">
          {StackTriageStrings.completed()}
        </Text>
        {store.history.length === 0 && (
          <Text variant="muted" as="div">
            {StackTriageStrings.nothingJudgedYet()}
          </Text>
        )}
        {store.history
          .map((entry, index) => ({ entry, index }))
          .reverse()
          .map(({ entry, index }) => {
            // Keep the rest is an entry with no round of its own: it ended the
            // session rather than judging a pair.
            // Disabled while a write is in flight, like every other control: a
            // rewind is dropped in that window, and a row that swallows the click
            // silently is worse than one that cannot be clicked.
            if (entry.choice === 'stopped') {
              return (
                <button
                  key={index}
                  type="button"
                  {...stylex.props(styles.row, focusRing.ring)}
                  disabled={store.busy}
                  onClick={() => void stackTriage.rewindTo(index)}
                >
                  <Text variant="muted">{StackTriageStrings.keptTheRest()}</Text>
                </button>
              );
            }
            const round = store.roundOfEntry(index);
            const [a, b] = round == null ? [undefined, undefined] : roundOf(round);
            return (
              <button
                key={index}
                type="button"
                {...stylex.props(styles.row, focusRing.ring)}
                disabled={store.busy}
                onClick={() => void stackTriage.rewindTo(index)}
              >
                {a != null && <img src={thumbnail(a)} alt="" {...stylex.props(styles.thumbnail)} />}
                {b != null && <img src={thumbnail(b)} alt="" {...stylex.props(styles.thumbnail)} />}
                <Text variant="muted">{choices.find((choice) => choice.verdict === entry.choice)?.label ?? ''}</Text>
              </button>
            );
          })}

        <Text variant="label" as="div">
          {StackTriageStrings.upcoming()}
        </Text>
        {store.upcoming.length === 0 && (
          <Text variant="muted" as="div">
            {StackTriageStrings.nothingAfterThisRound()}
          </Text>
        )}
        {/* Read-only, and visibly so: a round that has not been judged is not
            somewhere to jump to. */}
        {store.upcoming.map((round) => {
          const [a, b] = roundOf(round);
          return (
            <div key={pairKey(round.a, round.b)} {...stylex.props(styles.row, styles.inert)}>
              {a != null && <img src={thumbnail(a)} alt="" {...stylex.props(styles.thumbnail)} />}
              {b != null && <img src={thumbnail(b)} alt="" {...stylex.props(styles.thumbnail)} />}
            </div>
          );
        })}
        {store.upcomingOverflow > 0 && <Text variant="muted">{StackTriageStrings.andMore(store.upcomingOverflow)}</Text>}
      </div>
    </PopoverButton>
  );
});
