import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePresenters, useViewerStore } from '../../../app/stores_context';
import { POPUP } from '../../../ui/menu_styles';
import { TRIAGE_KEYS } from '../stack_triage/triage_control';
import { useJudge, useStep } from './detail_navigation';
import type { DetailMode } from './detail_mode';
import type { ViewerRendition } from '../../../../../src/schemas/settings';

const RENDITION_KEYS: Partial<Record<string, ViewerRendition>> = {
  i: 'embedded',
  o: 'full',
  p: 'max',
};

export const DetailKeys = observer(function DetailKeys({
  photoId,
  mode,
  onExitPreview,
  onToggleStrip,
  onTogglePanels,
  culls = true,
}: {
  photoId: string;
  mode: DetailMode;
  /** Absent where the page has only the `view` mode, which has no preview to leave. */
  onExitPreview?: () => void;
  /** Whether the rating and verdict keys judge the photo. */
  culls?: boolean;
  /** Absent where the viewer offers no such toggle: a phone, a touch editor, and the mockup. */
  onToggleStrip?: () => void;
  onTogglePanels?: () => void;
}): null {
  const store = useViewerStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();
  const step = useStep();
  const judge = useJudge(photoId);
  const back = store.openedFrom.path;

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // A focused control already acted on it: a tone curve point's arrow nudges the point.
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Rating (and any other) flyout owns its own keys while open; arrow-stepping
      // out from under an open popup is worse than ignoring the cull shortcuts.
      if (target?.closest(POPUP) != null) return;

      // Edit mode owns Escape: discard the grade and return to the viewer, rather than
      // leaving the photo the way the ordinary viewer does.
      if (e.key === 'Escape' && document.fullscreenElement == null && mode !== 'view') {
        onExitPreview?.();
        e.preventDefault();
        return;
      }

      if (mode === 'print' && ['i', 'o', 'p'].includes(e.key)) return;

      const verdict = culls ? TRIAGE_KEYS[e.key] : undefined;
      const rendition = RENDITION_KEYS[e.key];
      if (verdict != null) judge(verdict);
      else if (culls && /^[0-5]$/.test(e.key)) void photos.setRating(photoId, Number(e.key));
      else if (rendition != null) void photos.chooseRendition(photoId, rendition);
      else if (e.key === '[' && onToggleStrip != null) onToggleStrip();
      else if (e.key === ']' && onTogglePanels != null) onTogglePanels();
      else if (e.key === 'ArrowLeft') step('prev');
      else if (e.key === 'ArrowRight') step('next');
      // Fullscreen owns Escape: there it leaves the fullscreen frame, not the photo.
      else if (e.key === 'Escape' && document.fullscreenElement == null) {
        photos.focusOpenPhoto();
        navigate(back);
      } else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    step,
    judge,
    navigate,
    back,
    photoId,
    photos,
    mode,
    onExitPreview,
    onToggleStrip,
    onTogglePanels,
    culls,
  ]);

  return null;
});
