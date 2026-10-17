import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { inOpenLayer, ownsArrows } from '../../../app/remote_navigation';
import {
  useListingStore,
  useMarksStore,
  usePresenters,
  useViewerStore,
} from '../../../app/stores_context';
import { TV_CONTROLS_SHOWN_MS } from '../../../app/tv';
import { EmptyState } from '../../../ui/empty_state';
import { Page } from '../../../ui/page';
import { Text } from '../../../ui/text';
import { color, size } from '../../../ui/tokens.stylex';
import { STRIP_ID } from '../grid/photo_strip';
import { photoPath, sourceOfPath } from '../photos_store';
import { CameraPanel } from './detail_panels';
import { DetailFilmstrip } from './detail_filmstrip';
import { DetailFrame } from './detail_frame';
import { DetailKeys } from './detail_keys';
import { ViewOnlyNav } from './detail_nav';
import { useDetailBox, useStripView } from './detail_page_hooks';
import { PhotoDetailStrings } from './photo_detail_page.strings';
import { styles } from './photo_detail_page.stylex';

const tvStyles = stylex.create({
  page: {
    position: 'relative',
  },
  stage: {
    // It holds the focus for the photo, which needs no frame to say so.
    outline: 'none',
  },
  controls: {
    display: 'contents',
  },
  hidden: {
    visibility: 'hidden',
  },
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    paddingTop: '12px',
    paddingInline: size.padX,
    backgroundColor: color.ink,
  },
  strip: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 1,
    paddingBottom: size.padB,
    paddingInline: size.padX,
    backgroundColor: color.ink,
  },
});

export const TvPhotoPage = observer(function TvPhotoPage(): JSX.Element {
  const { photoId = '' } = useParams();
  const store = useViewerStore();
  const listing = useListingStore();
  const marks = useMarksStore();
  const { photos, appSettings } = usePresenters();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [controlsShown, setControlsShown] = useState(false);
  const strip = useStripView();
  useDetailBox(box);

  useEffect(() => {
    void photos.openDetail(photoId, sourceOfPath(pathname));
    void appSettings.load();
  }, [photoId, pathname, photos, appSettings]);

  useEffect(() => box?.focus({ preventScroll: true }), [box]);

  const hideControls = useCallback((): void => {
    setControlsShown(false);
    // Hidden, the bar and the strip drop whatever focus they held to the body.
    box?.focus({ preventScroll: true });
  }, [box]);

  useEffect(() => {
    if (!controlsShown) return;
    // Here rather than on the press: until this render the strip is hidden, and takes no focus.
    document.getElementById(STRIP_ID)?.focus({ preventScroll: true });
    let timer: ReturnType<typeof setTimeout>;
    const extend = (): void => {
      clearTimeout(timer);
      timer = setTimeout(expire, TV_CONTROLS_SHOWN_MS);
    };
    const expire = (): void => {
      // Hidden under an open menu, the bar would leave it holding the focus over nothing.
      if (document.activeElement != null && inOpenLayer(document.activeElement)) extend();
      else hideControls();
    };
    extend();
    window.addEventListener('keydown', extend, { capture: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', extend, { capture: true });
    };
  }, [controlsShown, hideControls]);

  const open = store.open;
  if (open?.id === photoId && open.status === 'missing') {
    return (
      <Page>
        {/* Back's way to the grid, with the sidebar hidden and nothing else here to focus. */}
        <DetailKeys photoId={photoId} mode="view" culls={false} />
        <EmptyState title={PhotoDetailStrings.photoUnavailable()}>
          <Text as="p" variant="muted">
            {open.error}
          </Text>
        </EmptyState>
      </Page>
    );
  }

  const onStageKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || e.key !== 'Enter' || e.repeat) return;
    photos.focusOpenPhoto();
    photos.showCursor();
    setControlsShown(true);
    e.preventDefault();
  };
  const onStripKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!(e.target instanceof HTMLElement) || e.target.id !== STRIP_ID) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      photos.moveFocus(e.key === 'ArrowLeft' ? -1 : 1);
      strip.presenter.revealPosition(marks.focusIndex);
    } else if (e.key === 'Enter') {
      // A held centre button would otherwise put away the controls its first press brought up.
      if (e.repeat) return;
      const chosen = marks.focusedPhoto;
      if (chosen == null || chosen.id === photoId) hideControls();
      else navigate(photoPath(chosen.id, listing.source));
    } else return;
    e.preventDefault();
  };
  const onControlsKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape') return;
    // A menu portalled out of the bar still passes through here, and closes on Escape itself.
    if (e.target instanceof Element && inOpenLayer(e.target)) return;
    hideControls();
    e.preventDefault();
  };

  return (
    <Page style={[styles.page, tvStyles.page]}>
      <DetailKeys photoId={photoId} mode="view" culls={false} />
      <div
        ref={setBox}
        tabIndex={-1}
        {...ownsArrows('all')}
        onKeyDown={onStageKey}
        {...stylex.props(styles.frame, tvStyles.stage)}
      >
        <div {...stylex.props(styles.detail, panelsOpen ? styles.beside : styles.only)}>
          <DetailFrame photoId={photoId} toolsInto={toolsSlot} zoomInto={null} />
          {panelsOpen && (
            <div
              {...stylex.props(styles.panels)}
              role="region"
              aria-label={PhotoDetailStrings.details()}
            >
              <CameraPanel photoId={photoId} defaultOpen style={styles.panelFlush} />
            </div>
          )}
        </div>
      </div>
      {/* Mounted while hidden: the stage draws its zoom readout into the bar, and the strip
          keeps its place in the collection. */}
      <div
        {...stylex.props(tvStyles.controls, !controlsShown && tvStyles.hidden)}
        // Captured: a button's tooltip stops Escape on its way up.
        onKeyDownCapture={onControlsKey}
      >
        <div {...stylex.props(tvStyles.bar)}>
          <ViewOnlyNav
            photoId={photoId}
            toolsRef={setToolsSlot}
            panelsOpen={panelsOpen}
            onTogglePanels={() => setPanelsOpen(!panelsOpen)}
          />
        </div>
        <div {...stylex.props(tvStyles.strip)} onKeyDown={onStripKey}>
          <DetailFilmstrip photoId={photoId} strip={strip} edge="below" />
        </div>
      </div>
    </Page>
  );
});
