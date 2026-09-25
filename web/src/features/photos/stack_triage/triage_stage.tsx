import * as stylex from '@stylexjs/stylex';
import { Eye } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef } from 'react';
import { usePresenters, useStackTriageStore } from '../../../app/stores_context';
import { Button } from '../../../ui/button';
import { ICON } from '../../../ui/icon';
import { Row } from '../../../ui/row';
import { Text } from '../../../ui/text';
import { PhotoStage } from '../viewer/photo_stage';
import { pairKey, sideKeys, SPLIT_GAP } from './stack_triage';
import { StackTriageStrings } from './stack_triage_page.strings';
import { SIDE_COLOR, styles } from './stack_triage_page.stylex';
import { drawnAxis, nameOf } from './triage_controls';

// Measured once per resize and written to the store, not read from the DOM where
// `arrangement` and `fitted` need it: they are called on every render, and the
// space they place boxes in is the one input neither can get from a store.
function useStageBox(): React.RefObject<HTMLDivElement> {
  const { stackTriage } = usePresenters();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const box = ref.current;
    if (box == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry == null) return;
      stackTriage.setStageBox(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [stackTriage]);

  return ref;
}

// One stage holding both frames of the round, showing one at a time. `photoKey`
// is the round, so zoom and pan survive the flip: that is the whole gesture, both
// frames at 100% over the same detail, alternating.
export const Flip = observer(function Flip({
  sides,
  peeking,
  onDecoded,
}: {
  /** The round's two photos in drawn order: A is the first of them, here as in split. */
  sides: [string, string];
  peeking: boolean;
  onDecoded: (source: string) => void;
}): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();
  const boxRef = useStageBox();
  const slot = store.showing === 'a' ? 0 : 1;
  const sources: [string, string] = [store.srcOf(sides[0]), store.srcOf(sides[1])];
  const nameAt = (id: string): string | undefined => {
    const member = store.members.get(id);
    return member == null ? undefined : nameOf(member);
  };  // Whichever frame is actually on screen, peek included. Labelled from slot A
  // regardless, both frames of a round claimed the same filename - on the one
  // screen whose job is telling near-identical photographs apart, and in
  // fullscreen the bar is the only thing left that names them at all.
  const showing = peeking ? 1 - slot : slot;
  const onScreenId = showing === 0 ? sides[0] : sides[1];
  const onScreen = store.members.get(onScreenId);
  // The photograph that is up, not the round: the frame wears its colour, so a
  // box the shape of the *other* one would put that colour a letterbox away from
  // the picture it names.
  const box = store.boxOf(onScreenId);

  return (
    <div ref={boxRef} {...stylex.props(styles.view, styles.flip)}>
      <div {...stylex.props(styles.frame)} style={{ width: `${box.width}px`, height: `${box.height}px` }}>
        <PhotoStage
          style={styles.stage}
          photoKey={pairKey(sides[0], sides[1])}
          // Two pictures, not two renditions of one: these are the round's two
          // photographs, and only one of them is up at a time.
          pictures={[
            { key: sides[0], sources: [sources[0]], alt: nameAt(sides[0]) },
            { key: sides[1], sources: [sources[1]], alt: nameAt(sides[1]) },
          ]}
          showing={showing}
          frameColor={showing === 0 ? SIDE_COLOR.a : SIDE_COLOR.b}
          // A round that opens on a photograph this one was not showing has swapped
          // the picture under the reader; the held-over winner is carried, so it is
          // left alone. A flip between the frames of one round is not a step and
          // never reaches this.
          step="fade"
          alt={onScreen == null ? '' : nameOf(onScreen)}
          filename={onScreen == null ? '' : nameOf(onScreen)}
          onImageLoad={(source, width, height) => {
            onDecoded(source);
            stackTriage.noteFrame(source === sources[0] ? sides[0] : sides[1], width, height);
          }}
        />
      </div>
    </div>
  );
});

export const ViewSwitch = observer(function ViewSwitch({
  peeking,
  onPeek,
}: {
  peeking: boolean;
  onPeek: (peeking: boolean) => void;
}): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();
  const slot = store.showing === 'a' ? 0 : 1;

  return (
    <Row style={styles.switch} role="group" aria-label={StackTriageStrings.whichPhotoToShow()}>
      <Button style={styles.markA} aria-pressed={!peeking && slot === 0} onClick={() => stackTriage.setShowing('a')}>
        {StackTriageStrings.showA()}
      </Button>
      <Button
        aria-pressed={peeking}
        aria-label={StackTriageStrings.peek()}
        tooltip={StackTriageStrings.peekTitle()}
        style={styles.peek}
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
        <Eye size={ICON} />
      </Button>
      <Button style={styles.markB} aria-pressed={!peeking && slot === 1} onClick={() => stackTriage.setShowing('b')}>
        {StackTriageStrings.showB()}
      </Button>
    </Row>
  );
});

// Both at once, each given the same displayed area, in whichever of row or column
// makes that area largest.
export const Split = observer(function Split({ onDecoded }: { onDecoded: (source: string) => void }): JSX.Element {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();
  const boxRef = useStageBox();

  const placed = store.placement;
  const sides = store.sides;
  const keys = sideKeys(drawnAxis(store));
  // The round, so that a half carried into the next one decodes and reports
  // again: the verdict bar waits on a report per round, and a key that held
  // across the round would leave the carried half silent and the bar dead.
  const roundKey = sides == null ? '' : pairKey(sides[0], sides[1]);

  return (
    <div
      ref={boxRef}
      {...stylex.props(styles.view)}
      style={{ flexDirection: placed?.direction ?? 'row', gap: `${SPLIT_GAP}px` }}
    >
      {store.shown?.map((photo, index) => {
        const size = placed == null ? undefined : index === 0 ? placed.a : placed.b;
        return (
          // By slot, not by photo: keyed by the photograph, the half a verdict
          // replaced would unmount with it, and the stage that arrives has nothing
          // to exchange with - the fade below needs the outgoing frame still
          // mounted under it.
          <div
            key={index}
            {...stylex.props(styles.frame)}
            style={size == null ? undefined : { width: `${size.width}px`, height: `${size.height}px` }}
          >
            <PhotoStage
              style={styles.stage}
              photoKey={`${roundKey}:${photo.id}`}
              pictures={[{ key: photo.id, sources: [store.srcOf(photo.id)] }]}
              frameColor={index === 0 ? SIDE_COLOR.a : SIDE_COLOR.b}
              // Which half changed is the whole question a verdict leaves: the
              // photo held over stays exactly as it was, and the one being
              // replaced says so.
              step="fade"
              alt={nameOf(photo)}
              filename={nameOf(photo)}
              // One stage owns the window-level fullscreen key, or both toggle on
              // a single press.
              keyboard={index === 0}
              onImageLoad={(source, width, height) => {
                onDecoded(source);
                stackTriage.noteFrame(photo.id, width, height);
              }}
            />
            {/* The key that picks this half, on the half itself: which of two
                stacked photographs `↓` means is not something a letter can say. */}
            <Text variant="mono" style={[styles.slot, index === 0 ? styles.slotA : styles.slotB]}>
              {StackTriageStrings.slot(index === 0 ? 'a' : 'b', index === 0 ? keys[0] : keys[1])}
            </Text>
          </div>
        );
      })}
    </div>
  );
});

// The keyboard layer. Its own component so a keystroke re-renders whatever owns
// what it changed, and nothing else.
