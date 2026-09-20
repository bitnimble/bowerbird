import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { usePresenters, useStackTriageStore } from '../../../app/stores_context';
import { POPUP } from '../../../ui/menu_styles';

export const TriageKeys = observer(function TriageKeys({
  peeking,
  ready,
  onPeek,
  onLeave,
}: {
  peeking: boolean;
  /** Both frames of this round are up. The keys wait for it as the buttons do. */
  ready: boolean;
  onPeek: (peeking: boolean) => void;
  onLeave: () => void;
}): null {
  const store = useStackTriageStore();
  const { stackTriage } = usePresenters();

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // A held key, not a decision. `Both` costs no write, so nothing rate-limits
      // it: auto-repeat runs the rest of the tournament off frames nobody looked
      // at, in about a second.
      if (e.repeat) return;
      // A popup is portalled to the body, so its keys reach this window listener:
      // reading the queue would cast verdicts, and Space on a queue row would cast
      // Both instead of selecting the round it is sitting on.
      if (target?.closest(POPUP) != null) return;

      // Undo is the only modified chord. Every other modifier is left alone
      // because Cmd+← and Alt+← are the browser's Back, and casting "Pick A" on
      // the way out of the page is not a verdict anybody made.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        // Swallowed while a write is in flight rather than passed on: the rewind
        // is dropped in that window, and handing ⌘Z back to the browser mid-session
        // is worse than doing nothing.
        if (!store.busy) void stackTriage.undo();
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
      // `v`, not Tab. Swallowing Tab took focus navigation away from the whole
      // page: nothing could be reached by keyboard, and once focus landed here
      // there was no way out of it.
      else if (e.key === 'v') stackTriage.setMode(store.mode === 'flip' ? 'split' : 'flip');
      else if (e.key === 'Backspace') {
        if (!store.busy) void stackTriage.undo();
      }
      // The same gate the buttons carry, `busy` and all. Without it the keyboard
      // was live while they were dead, so one deliberate press could reject a
      // photograph nobody had seen - and a warmed round decodes inside the beat
      // its predecessor's writes are still in flight, which is a window where the
      // bar is grey and every key still answers. Leaving and switching
      // presentation stay available while the stage builds.
      else if (store.round == null || !ready || store.busy) return;
      // Both arrows of an axis are bound at once, so the pair laid out top and
      // bottom answers to the keys that point at it - and no key changes meaning
      // when a resize flips the arrangement. Both is Space alone; it lost ↓ to
      // the photograph below.
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') void stackTriage.judge('a');
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') void stackTriage.judge('b');
      else if (e.key === ' ') void stackTriage.judge('both');
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
    // `ready` is a dependency, or the handler closes over the first render's
    // `false` and the verdict keys never come back.
  }, [store, stackTriage, peeking, ready, onPeek, onLeave]);

  return null;
});

