import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  Check,
  ChevronsLeftRight,
  Columns2,
  Equal,
  Layers,
  ListOrdered,
  RotateCcw,
  SquareStack,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { renditionUrl, type PhotoSummary } from '../../api/client';
import { usePresenters, useStackTriageStore } from '../../app/stores_context';
import { Button, ICON, PopoverButton, SegmentedControl, Text } from '../../ui/ui';
import { PhotoStage } from './photo_stage';
import { renditionVersion } from './photos_store';
import { type Round, type Verdict, SPLIT_GAP, pairKey } from './stack_triage';

// Stack triage (DESIGN §20): one stack, judged two photos at a time.

const VERDICTS: { verdict: Verdict; label: string; hint: string; danger?: boolean }[] = [
  { verdict: 'a', label: 'A better', hint: '←' },
  { verdict: 'both', label: 'Both', hint: '↓' },
  { verdict: 'b', label: 'B better', hint: '→' },
  // Click-only. The one key left is ↑, directly above the verdict that destroys
  // nothing, which is the wrong neighbour for the one that destroys two.
  { verdict: 'neither', label: 'Neither', hint: '', danger: true },
];

function nameOf(photo: PhotoSummary): string {
  return photo.file_path.split('/').pop() ?? photo.id;
}

// The grid rendition, which is what a band already draws: a contact-sheet row
// wants the thumbnail, where the session's own rendition is for judging.
function thumbOf(photo: PhotoSummary): string {
  return renditionUrl(photo.id, 'grid', renditionVersion(photo, 'grid'));
}

function Thumb({ photo, note }: { photo: PhotoSummary; note?: string }): JSX.Element {
  return (
    <Link to={`/photos/${photo.id}`} className="triage__thumb" title={nameOf(photo)}>
      <img src={thumbOf(photo)} alt={nameOf(photo)} />
      {note != null && <span className="triage__thumb-note">{note}</span>}
    </Link>
  );
}

// The rounds already judged and the ones still projected. Selecting a completed
// round rewinds to it, which is the same operation undo performs, offered by name
// rather than by depth.
const Queue = observer(function Queue(): JSX.Element {
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
          Queue
        </>
      }
    >
      <div className="triage__queue">
        <Text variant="label" as="div">
          Completed
        </Text>
        {store.history.length === 0 && (
          <Text variant="muted" as="div">
            Nothing judged yet
          </Text>
        )}
        {store.history
          .map((entry, index) => ({ entry, index }))
          .reverse()
          .map(({ entry, index }) => {
            // Keep the rest is an entry with no round of its own: it ended the
            // session rather than judging a pair.
            if (entry.choice === 'stopped') {
              return (
                <button key={index} type="button" className="triage__queue-row" onClick={() => void stackTriage.rewindTo(index)}>
                  <Text variant="muted">Kept the rest</Text>
                </button>
              );
            }
            const round = store.roundOfEntry(index);
            const [a, b] = round == null ? [undefined, undefined] : roundOf(round);
            return (
              <button key={index} type="button" className="triage__queue-row" onClick={() => void stackTriage.rewindTo(index)}>
                {a != null && <img src={thumbOf(a)} alt="" />}
                {b != null && <img src={thumbOf(b)} alt="" />}
                <Text variant="muted">{VERDICTS.find((v) => v.verdict === entry.choice)?.label ?? ''}</Text>
              </button>
            );
          })}

        <Text variant="label" as="div">
          Upcoming
        </Text>
        {store.upcoming.length === 0 && (
          <Text variant="muted" as="div">
            Nothing after this round
          </Text>
        )}
        {/* Read-only, and visibly so: a round that has not been judged is not
            somewhere to jump to. */}
        {store.upcoming.map((round) => {
          const [a, b] = roundOf(round);
          return (
            <div key={pairKey(round.a, round.b)} className="triage__queue-row triage__queue-row--inert">
              {a != null && <img src={thumbOf(a)} alt="" />}
              {b != null && <img src={thumbOf(b)} alt="" />}
            </div>
          );
        })}
        {store.upcomingOverflow > 0 && <Text variant="muted">{`and ${store.upcomingOverflow} more`}</Text>}
      </div>
    </PopoverButton>
  );
});

const Header = observer(function Header({ onLeave }: { onLeave: () => void }): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();

  return (
    <div className="row detail__nav">
      <Button onClick={onLeave}>
        <ArrowLeft size={ICON} />
        Back
      </Button>
      <Text variant="mono">
        <Layers size={ICON} /> {`${store.members.size} in this stack`}
      </Text>

      <div className="spacer" />

      <Queue />
      {/* Both presentations named and one of them pressed, as the gallery names
          its own views: a single button labelled with the mode it is already in
          cannot say whether it reports the state or changes it. */}
      {store.status === 'running' && (
        <SegmentedControl
          label="Presentation"
          value={store.mode}
          onChange={stackTriage.setMode}
          options={[
            { value: 'flip', label: 'Flip', icon: <SquareStack size={ICON} />, hint: '⇥' },
            { value: 'split', label: 'Split', icon: <Columns2 size={ICON} /> },
          ]}
        />
      )}
    </div>
  );
});

// One stage holding both frames of the round, showing one at a time. `photoKey`
// is the round, so zoom and pan survive the flip: that is the whole gesture, both
// frames at 100% over the same detail, alternating.
const Flip = observer(function Flip({
  round,
  peeking,
  onPeek,
  onDecoded,
}: {
  round: Round;
  peeking: boolean;
  onPeek: (peeking: boolean) => void;
  onDecoded: (source: string) => void;
}): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();
  const slot = store.showing === 'a' ? 0 : 1;
  const sources = [store.srcOf(round.a), store.srcOf(round.b)];
  const a = store.members.get(round.a);

  return (
    <div className="triage__flip">
      <div className="row triage__switch" role="group" aria-label="Which photo to show">
        <Button aria-pressed={!peeking && slot === 0} onClick={() => stackTriage.setShowing('a')}>
          A
        </Button>
        <Button
          aria-pressed={peeking}
          aria-label="Hold to see the other photo"
          title="Hold to see the other photo (Shift)"
          className="triage__peek"
          onPointerDown={(e: React.PointerEvent) => {
            // Capture, so releasing outside the button still ends the peek rather
            // than leaving the other photo pinned up.
            try {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            } catch {
              /* the leave and cancel handlers still end it */
            }
            onPeek(true);
          }}
          onPointerUp={() => onPeek(false)}
          onPointerCancel={() => onPeek(false)}
          onPointerLeave={() => onPeek(false)}
        >
          <ChevronsLeftRight size={ICON} />
        </Button>
        <Button aria-pressed={!peeking && slot === 1} onClick={() => stackTriage.setShowing('b')}>
          B
        </Button>
      </div>

      <PhotoStage
        photoKey={pairKey(round.a, round.b)}
        sources={sources}
        showing={peeking ? 1 - slot : slot}
        alt={a == null ? '' : nameOf(a)}
        filename={a == null ? '' : nameOf(a)}
        onImageLoad={(source) => onDecoded(source)}
      />
    </div>
  );
});

// Both at once, each given the same displayed area, in whichever of row or column
// makes that area largest.
const Split = observer(function Split({ round, onDecoded }: { round: Round; onDecoded: (source: string) => void }): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();
  const boxRef = useRef<HTMLDivElement>(null);

  // The one input `arrangement` cannot get from a store it already has. Measured
  // once per resize, in the presenter, and read back as a number by every render.
  useEffect(() => {
    const box = boxRef.current;
    if (box == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry == null) return;
      stackTriage.setSplitBox(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [stackTriage]);

  const placed = store.placement;
  const pair = store.pair;

  return (
    <div ref={boxRef} className="triage__split" style={{ flexDirection: placed?.direction ?? 'row', gap: `${SPLIT_GAP}px` }}>
      {pair?.map((photo, index) => {
        const size = placed == null ? undefined : index === 0 ? placed.a : placed.b;
        return (
          <div
            key={photo.id}
            className="triage__half"
            style={size == null ? undefined : { width: `${size.width}px`, height: `${size.height}px` }}
          >
            <PhotoStage
              photoKey={`${pairKey(round.a, round.b)}:${photo.id}`}
              sources={[store.srcOf(photo.id)]}
              alt={nameOf(photo)}
              filename={nameOf(photo)}
              // One stage owns the window-level fullscreen key, or both toggle on
              // a single press.
              keyboard={index === 0}
              onImageLoad={(source) => onDecoded(source)}
            />
            <Text variant="mono" className="triage__slot">
              {index === 0 ? 'A' : 'B'}
            </Text>
          </div>
        );
      })}
    </div>
  );
});

const Verdicts = observer(function Verdicts({ ready }: { ready: boolean }): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage, toasts } = usePresenters();

  const cast = (verdict: Verdict): void => {
    const round = store.round;
    if (round == null) return;
    void stackTriage.judge(verdict).then(() => {
      // Reported with an undo rather than confirmed first, matching the Bin: a
      // confirmation on a repeated action is worse than a way back from it.
      if (verdict === 'neither') toasts.showUndoable('2 rejected', 'Undo', () => stackTriage.undo());
    });
  };

  return (
    <div className="row triage__verdicts">
      {VERDICTS.map(({ verdict, label, hint, danger }) => (
        <Button
          key={verdict}
          variant={danger === true ? 'danger' : 'default'}
          disabled={!ready || store.busy}
          onClick={() => cast(verdict)}
        >
          {verdict === 'both' ? <Equal size={ICON} /> : verdict === 'neither' ? <Ban size={ICON} /> : null}
          {label}
          {hint !== '' && <span className="ui-btn__hint">{hint}</span>}
        </Button>
      ))}

      <div className="spacer" />

      <Button disabled={store.history.length === 0 || store.busy} onClick={() => void stackTriage.undo()}>
        <RotateCcw size={ICON} />
        Undo
        <span className="ui-btn__hint">⌘Z</span>
      </Button>
      <Button disabled={store.busy} onClick={() => void stackTriage.keepTheRest()}>
        <Check size={ICON} />
        Keep the rest
      </Button>
      {/* An upper bound that only falls, so it is labelled as one: a draw lowers
          it while the pool stays the same size, which would otherwise read as a
          counter that had stalled. */}
      <Text variant="mono">{`${store.pool.length} left · up to ${store.remaining} ${store.remaining === 1 ? 'round' : 'rounds'}`}</Text>
    </div>
  );
});

const Summary = observer(function Summary({ onLeave }: { onLeave: () => void }): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();
  const { kept, rejected, unsaved } = store.outcome;
  const unjudged = store.unjudged;

  return (
    <div className="triage__summary">
      {kept.length === 0 ? (
        <Text as="p" variant="muted">
          Every frame in this stack was rejected.
        </Text>
      ) : (
        <>
          <Text variant="label" as="div">{`Kept · ${kept.length}`}</Text>
          <div className="triage__row">
            {kept.map((photo) => (
              // A survivor Keep the rest left in the pool was never on screen, and
              // nothing is claimed of it: it is drawn, and it is marked.
              <Thumb key={photo.id} photo={photo} note={unjudged.has(photo.id) ? 'not compared' : undefined} />
            ))}
          </div>
        </>
      )}

      {rejected.length > 0 && (
        <>
          <Text variant="label" as="div">{`Rejected · ${rejected.length}`}</Text>
          <div className="triage__row">
            {rejected.map((photo) => (
              <Thumb key={photo.id} photo={photo} />
            ))}
          </div>
        </>
      )}

      {unsaved.length > 0 && (
        <>
          <Text variant="label" as="div">{`Not saved · ${unsaved.length}`}</Text>
          <div className="triage__row">
            {unsaved.map((photo) => (
              <Thumb key={photo.id} photo={photo} />
            ))}
          </div>
          <Button onClick={() => void stackTriage.retryFailed()}>Retry</Button>
        </>
      )}

      <div className="row">
        <Button disabled={store.history.length === 0} onClick={() => void stackTriage.undo()}>
          <RotateCcw size={ICON} />
          Undo the last round
        </Button>
        <Button variant="primary" onClick={onLeave}>
          Done
        </Button>
      </div>
    </div>
  );
});

// The keyboard layer. Its own component so a keystroke re-renders whatever owns
// what it changed, and nothing else.
const TriageKeys = observer(function TriageKeys({
  peeking,
  onPeek,
  onLeave,
}: {
  peeking: boolean;
  onPeek: (peeking: boolean) => void;
  onLeave: () => void;
}): null {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      // Undo is the only modified chord. Every other modifier is left alone
      // because Cmd+← and Alt+← are the browser's Back, and casting "A better" on
      // the way out of the page is not a verdict anybody made.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        void stackTriage.undo();
        e.preventDefault();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'Shift' && store.mode === 'flip') {
        onPeek(true);
        return;
      }
      // A peek casts the inverse of what is on screen, which is the most
      // destructive misfire here, and Shift-then-arrow is an easy accident.
      if (peeking) return;

      if (e.key === 'Escape') onLeave();
      else if (e.key === 'Tab') stackTriage.setMode(store.mode === 'flip' ? 'split' : 'flip');
      else if (e.key === 'Backspace') void stackTriage.undo();
      else if (store.round == null) return;
      else if (e.key === 'ArrowLeft') void stackTriage.judge('a');
      else if (e.key === 'ArrowRight') void stackTriage.judge('b');
      else if (e.key === 'ArrowDown' || e.key === ' ') void stackTriage.judge('both');
      else return;
      e.preventDefault();
    }

    // A modifier held across a Cmd+Tab never delivers its keyup, so without the
    // window-level clears the peek sticks until the photographer thinks to press
    // and release the key again.
    function onKeyUp(e: KeyboardEvent): void {
      if (e.key === 'Shift') onPeek(false);
    }
    const clear = (): void => onPeek(false);

    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clear);
    };
  }, [store, stackTriage, peeking, onPeek, onLeave]);

  return null;
});

export const StackTriagePage = observer(function StackTriagePage(): JSX.Element {
  const { stackId = '' } = useParams();
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();
  const navigate = useNavigate();
  const [peeking, setPeeking] = useState(false);
  const [decoded, setDecoded] = useState<ReadonlySet<string>>(new Set());

  const entryPhotoId = (history.state as { usr?: { entryPhotoId?: string } } | null)?.usr?.entryPhotoId ?? null;

  useEffect(() => {
    void stackTriage.open(stackId, entryPhotoId);
  }, [stackId, entryPhotoId, stackTriage]);

  const onDecoded = useCallback((source: string) => {
    setDecoded((previous) => (previous.has(source) ? previous : new Set(previous).add(source)));
  }, []);

  // An explicit route rather than navigate(-1): nothing in the app uses history
  // depth, and it strands anyone who refreshed or opened the URL directly on a
  // history stack with nothing behind it.
  const leave = useCallback(() => {
    const photoId = store.entryPhotoId;
    if (photoId != null) {
      navigate(`/photos/${photoId}`);
      return;
    }
    const library = store.members.values().next().value?.library_id;
    navigate(library == null ? '/' : `/libraries/${library}`);
  }, [navigate, store]);

  const round = store.round;
  const pair = store.pair;

  if (store.status === 'loading') {
    return (
      <div className="pad">
        <Text variant="muted">Loading the stack…</Text>
      </div>
    );
  }

  if (store.status === 'error' || store.status === 'too-few') {
    return (
      <div className="pad">
        <div className="empty">
          <div className="empty__title">{store.status === 'error' ? 'Could not open the stack' : 'Nothing to compare'}</div>
          <Text as="p" variant="muted">
            {store.loadError ?? 'This stack has fewer than two photos left in it.'}
          </Text>
          <Button onClick={leave}>Back</Button>
        </div>
      </div>
    );
  }

  // Both frames of the round have to be up before a verdict can be cast, or a
  // photograph could be rejected against a stage that is still building it.
  const ready = pair != null && pair.every((photo) => decoded.has(store.srcOf(photo.id)));

  return (
    <div className="pad triage-page">
      <TriageKeys peeking={peeking} onPeek={setPeeking} onLeave={leave} />
      <Header onLeave={leave} />

      {round == null || pair == null ? (
        <Summary onLeave={leave} />
      ) : (
        <>
          {store.mode === 'flip' ? (
            <Flip round={round} peeking={peeking} onPeek={setPeeking} onDecoded={onDecoded} />
          ) : (
            <Split round={round} onDecoded={onDecoded} />
          )}
          <Verdicts ready={ready} />
          {/* Announced, because the screen replaces its entire content on a
              keystroke and would otherwise change in silence. */}
          <div className="visually-hidden" aria-live="polite">
            {`Round of ${store.pool.length} photos remaining`}
          </div>
          {/* The pool, warmed. The frames that can open the next round are drawn
              at stage size so they are instant; the rest are fetched so the bytes
              are in cache without holding a full-resolution raster each. */}
          <div className="triage__warm" aria-hidden>
            {store.warm.map((id) => (
              <img key={id} src={store.srcOf(id)} alt="" className={store.hot.includes(id) ? 'triage__warm-hot' : undefined} />
            ))}
          </div>
        </>
      )}
    </div>
  );
});
