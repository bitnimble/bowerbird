import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useListingStore, useMarksStore, usePresenters } from '../../../app/stores_context';
import { photoPath } from '../photos_store';

// The grid's keyboard layer. Separate component so a keystroke that only moves
// the cursor re-renders the two affected tiles, not the page.
export const GridKeys = observer(function GridKeys({ scrollerId }: { scrollerId: string }): null {
  const listing = useListingStore();
  const marks = useMarksStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      // A dialog over the grid owns its keys: Delete on its button would bin the tile under it.
      if (target?.closest('[role="dialog"]') != null) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Arrowing the cursor is the reader taking the grid over, so the focus comes
      // with it: it is what makes Enter unambiguously the grid's rather than the
      // sidebar link they came in by, and it leaves the tab order where they are.
      // preventScroll because the scroller is the thing being focused, and letting
      // the browser bring it into view fights the rail (§18.3.2).
      if (e.key.startsWith('Arrow')) {
        const scroller = document.getElementById(scrollerId);
        if (scroller != null && !scroller.contains(document.activeElement)) scroller.focus({ preventScroll: true });
      }

      // Whether the reader has tabbed onto something that owns its own activation
      // keys. A tile's frame is one of these: Enter on it is how it opens, and the
      // grid taking that key from it is what turned a link into a page load.
      const onControl = target?.closest('button, a') != null;

      // The real count, which the grid is laid out from rather than guessed at:
      // a fixed six sent the cursor to the wrong row at every other zoom.
      const columns = listing.columns;
      switch (e.key) {
        case 'ArrowRight':
          photos.moveFocus(1);
          break;
        case 'ArrowLeft':
          photos.moveFocus(-1);
          break;
        case 'ArrowDown':
          photos.moveFocus(columns);
          break;
        case 'ArrowUp':
          photos.moveFocus(-columns);
          break;
        case 'z':
          void photos.setFocusedTriage('untriaged');
          break;
        case 'c':
          void photos.togglePickFocused();
          break;
        case 'x':
          void photos.toggleRejectFocused();
          break;
        case 'Delete':
        case 'Backspace':
          void photos.binFocused();
          break;
        case ' ':
          // A control the reader has tabbed to owns its Space: it is how a tick
          // box is ticked, and the preventDefault below suppresses the click a
          // button synthesises from it - which left Space toggling whatever the
          // cursor happened to be on instead of the box under the focus ring.
          if (onControl) return;
          photos.toggle(marks.focusIndex);
          break;
        case 'Enter': {
          // Only from the grid: every other button, menu item and dialog owns its
          // own Enter. A focused tile owns it too, and is left to activate itself
          // - the click it synthesises runs the frame's own handler, which is what
          // drives the router, where preventDefault here would swallow it and a
          // bare return would let the browser follow the href as a page load.
          const fromGrid = target == null || target === document.body || target.closest(`#${scrollerId}`) != null;
          if (!fromGrid || onControl) return;
          const focused = marks.focusedPhoto;
          if (focused == null) return;
          if (focused.stack_id != null && focused.stack_size > 1) void photos.toggleBand(focused.stack_id, marks.focusIndex);
          else navigate(photoPath(focused.id, listing.source));
          break;
        }
        case 'Escape':
          // With nothing to drop, Escape belongs to whatever else is listening for
          // it - a menu, a dialog.
          if (!marks.hasSelection && !marks.showsCursor) return;
          photos.dismissSelection();
          break;
        default:
          if (/^[0-5]$/.test(e.key)) void photos.rateFocused(Number(e.key));
          else return;
      }
      // Every key above but Escape acts on the cursor, so the keyboard is driving
      // and the ring is drawn: a cull key firing on a tile nothing marks is a
      // verdict - or a bin - the reader cannot see the target of (§18.3.1).
      if (e.key !== 'Escape') photos.showCursor();
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photos, listing, marks, navigate]);

  return null;
});
