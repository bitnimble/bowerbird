import { useEffect, type RefObject } from 'react';
import { PhotoStageStrings } from '../features/photos/viewer/photo_stage.strings';
import { drawer } from './drawer.stylex';

// Mirrors `size.sidebarW`, which the drawer's own width comes from: the gesture needs it to say
// how far along the slide a finger has got, and it is needed before the sidebar is on screen.
const SIDEBAR_MAX = 280;
const SIDEBAR_SHARE = 0.82;

// How far a drag has to travel before it is this gesture rather than a press that moved -
// and, once it is, where the finger has to be let go for the drawer to stay open.
const CLAIM = 20;
const SETTLE = 0.5;

// What already means something by being dragged sideways, and so is not the drawer being
// asked for: a stage steps photographs and pans, a slider carries a value, a filmstrip
// along the foot scrolls the collection. Asked of the element rather than of the route, so
// a page that grows either later needs no change here.
//
// The strip only when it runs sideways: down the side of the photograph it scrolls the
// other way, and a drag across it is the drawer like anywhere else.
const OWNS_SIDEWAYS = [
  `[role="region"][aria-label="${PhotoStageStrings.stage()}"]`,
  '[role="group"]:has(input[type="range"])',
  '[data-owns-sideways]',
].join(', ');

const PROGRESS = drawer.progress.slice('var('.length, -')'.length);

const sidebarWidth = (): number => Math.min(SIDEBAR_MAX, window.innerWidth * SIDEBAR_SHARE);

/**
 * A drag rightwards pulls the sidebar out with the finger on a phone, and one back leftwards
 * pushes it away again; let go past halfway and it settles open, short of it and it closes.
 *
 * Anywhere on the page, not an edge zone: the drawer is the only thing a horizontal drag
 * means on a grid or a list, and a 20px strip is a target in its own right - which is the
 * thing a gesture is supposed to save you from.
 *
 * **Touch events rather than pointer events, which is the whole reason this works over the
 * grid.** A scroller takes the touch the moment it decides the gesture is a scroll, and
 * taking it means `pointercancel` and no further `pointermove` - so a pointer-based version
 * sees the finger land and never sees it travel, on every page that scrolls. Touches keep
 * arriving throughout. Listeners are passive and nothing is ever prevented, so the scroll
 * the browser decided on still happens.
 *
 * **How far it is open is a CSS variable written straight to the element, not React state.**
 * It changes every frame of the drag, and a re-render of the whole shell per frame is a
 * price the photographs would pay. React is told twice: when the drag claims the gesture,
 * and where it ended up.
 */
export function useDrawerSwipe({
  active,
  open,
  setOpen,
  setDragging,
  shell,
}: {
  active: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
  setDragging: (dragging: boolean) => void;
  /** Carries `drawer.progress`, which the sidebar's transform and the scrim's opacity are drawn from. */
  shell: RefObject<HTMLElement | null>;
}): void {
  useEffect(() => {
    if (!active) return;
    let from: { x: number; y: number } | null = null;
    let following = false;
    let progress = open ? 1 : 0;

    const forget = (): void => {
      from = null;
    };

    const down = (event: TouchEvent): void => {
      const touch = event.touches[0];
      if (touch == null || event.touches.length !== 1) return;
      // Only while it is shut: open, the drawer is over all of them anyway.
      if (!open && (event.target as Element | null)?.closest(OWNS_SIDEWAYS) != null) return;
      from = { x: touch.clientX, y: touch.clientY };
      following = false;
    };

    const move = (event: TouchEvent): void => {
      if (from == null) return;
      const touch = event.touches[0];
      // A second finger is a pinch or a scroll being steadied, not this, and a move already
      // prevented belongs to whatever prevented it: a long press dragging over photos to pick them.
      if (touch == null || event.touches.length !== 1 || event.defaultPrevented) {
        from = null;
        return;
      }
      const dx = touch.clientX - from.x;

      if (!following) {
        if (Math.abs(dx) < CLAIM) return;
        // Judged once, at the moment it is claimed: after that the finger is dragging the
        // drawer and may wander up and down the screen doing it.
        if (Math.abs(touch.clientY - from.y) > Math.abs(dx)) {
          from = null;
          return;
        }
        following = true;
        setDragging(true);
      }

      const width = sidebarWidth();
      progress = Math.min(1, Math.max(0, ((open ? width : 0) + dx) / width));
      shell.current?.style.setProperty(PROGRESS, String(progress));
    };

    const up = (): void => {
      from = null;
      if (!following) return;
      following = false;
      // Handing the resting place back to the stylesheet is what starts the ease: the
      // inline value was beating the class, and removing it leaves 0 or 1 to travel to.
      shell.current?.style.removeProperty(PROGRESS);
      setDragging(false);
      setOpen(progress > SETTLE);
    };

    window.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', up, { passive: true });
    window.addEventListener('touchcancel', forget, { passive: true });
    return () => {
      window.removeEventListener('touchstart', down);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', up);
      window.removeEventListener('touchcancel', forget);
    };
  }, [active, open, setOpen, setDragging, shell]);
}
