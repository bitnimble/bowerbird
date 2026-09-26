import * as stylex from '@stylexjs/stylex';
import { Eraser, Redo2, TriangleAlert, Undo2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { usePresenters } from '../../../app/stores_context';
import { MOST_FEATHER } from '../../../../../src/schemas/assembly';
import { Button } from '../../../ui/button';
import { EmptyState } from '../../../ui/empty_state';
import { ICON } from '../../../ui/icon';
import { Page, PageHead, ShowSidebarButton } from '../../../ui/page';
import { DRAGS_WINDOW } from '../../../ui/title_bar';
import { Row, Spacer } from '../../../ui/row';
import { Slider } from '../../../ui/slider';
import { Text } from '../../../ui/text';
import { color } from '../../../ui/tokens.stylex';
import { Tooltip } from '../../../ui/tooltip';
import { MergePageStrings } from './merge_page.strings';
import { MergePresenter } from './merge_presenter';
import type { Point } from './merge_rect';
import { MergeStage } from './merge_stage';
import { MergeStore } from './merge_store';
import { MergeTilePopup } from './merge_tile_popup';
import { stageStyles } from '../viewer/photo_stage.stylex';
import { type CanvasSize, useStageCanvas } from '../viewer/stage_canvas';
import { Spinner } from '../../../ui/spinner';
import { PhotoStageStrings } from '../viewer/photo_stage.strings';
import { collectionPath, photoPath, sourceOfPath } from '../photos_store';
import { ZoomControl } from '../viewer/zoom_control';
import { CLICK_SLOP_PX, NO_SIZE, framePointOf, travelOf, useZoomPan } from '../viewer/zoom_pan';

// CSS pixels, not the viewBox's: the analysis plane is thousands of pixels across in a stage of
// hundreds, so a scaling stroke is half a pixel fitted and a slab at 1:1.
const NON_SCALING = 'non-scaling-stroke';

const styles = stylex.create({
  status: {
    flexGrow: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
  },
  nav: {
    marginBottom: '8px',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  blend: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  blendSlider: {
    width: '140px',
  },
  tools: {
    display: 'contents',
  },
  unaligned: {
    display: 'inline-flex',
    alignItems: 'center',
    color: color.ochre,
    cursor: 'help',
  },
  stage: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    minHeight: 0,
  },
  seeding: {
    cursor: 'crosshair',
  },
  view: {
    position: 'absolute',
    inset: 0,
    transformOrigin: 'center',
  },
  layer: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  },
  canvas: {
    display: 'block',
    objectFit: 'contain',
  },
  piece: {
    fill: 'transparent',
    stroke: color.glass,
    strokeWidth: 1.25,
    strokeOpacity: 0.8,
    filter: 'drop-shadow(0 0 1px rgb(0 0 0 / 65%))',
    cursor: 'pointer',
  },
  inert: {
    pointerEvents: 'none',
  },
  // Still hit-tested: `visibility` would drop the click with the stroke.
  quiet: {
    strokeOpacity: 0,
  },
  hovered: {
    fill: 'rgb(255 255 255 / 8%)',
    strokeWidth: 2.5,
    strokeOpacity: 1,
  },
});

export const MergePage = observer(function MergePage(): JSX.Element {
  // One or the other, by route: an analysis job, or a finished assembly being picked again.
  const { jobId = '', photoId } = useParams();
  const { toasts } = usePresenters();
  const location = useLocation();
  const navigate = useNavigate();
  const source = useMemo(() => sourceOfPath(location.pathname), [location.pathname]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const handCanvas = useStageCanvas(canvasRef);
  const pressedAt = useRef<Point | null>(null);
  const dragged = useRef(false);
  // Whether the press a click ends found a popup open: that press closed it, and opens or seeds nothing.
  const dismissing = useRef(false);
  // Where the viewport starts on the page, read when the pointer arrives and not while it moves:
  // the rest of the mapping is arithmetic over the observed box and the view.
  const origin = useRef({ left: 0, top: 0 });
  const [committing, setCommitting] = useState(false);

  const [session] = useState(() => {
    const store = new MergeStore();
    // A box rather than the stage itself: the presenter is built before the canvas exists, and a
    // remount hands it a different one without rebuilding the session.
    const stage: { current: MergeStage | null } = { current: null };
    const presenter = new MergePresenter(store, toasts, {
      draw: (base, layers) => stage.current?.draw(base, layers),
      drawSettled: (settled) => stage.current?.drawSettled(settled),
    });
    return { store, presenter, stage };
  });

  useLayoutEffect(() => {
    if (photoId != null) void session.presenter.openExisting(photoId);
    else void session.presenter.openJob(jobId);
    return () => session.presenter.finish();
  }, [session, jobId, photoId]);

  const { store, presenter } = session;
  const layers = store.layers;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const size = (): CanvasSize => ({ width: store.layerSize?.width ?? 0, height: store.layerSize?.height ?? 0 });
    session.stage.current = canvas == null ? null : new MergeStage(canvas, size, layers);
    // The analysis lands before this canvas exists, so without a draw from here the picture stays
    // black until the reader happens to press something.
    if (canvas != null) session.presenter.redraw();
  }, [session, layers, store]);

  // §2.8's `[` and `]`. On the window rather than the stage: the reader's focus is wherever they
  // last clicked, and the picture is not a focusable element to put this on.
  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === '[') presenter.stepTile(-1);
      else if (event.key === ']') presenter.stepTile(1);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenter]);

  // Registered before any popup mounts, so it runs ahead of the popup's own capturing listener
  // that closes it on this same press.
  useEffect(() => {
    function onDown(): void {
      dismissing.current = store.openTile != null;
    }
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [store]);

  // The viewer's own stage and the viewer's own gesture: the picture is fitted into a viewport that
  // fills the page rather than being the size of its own canvas, so a tile's flyout has somewhere
  // clear of the tile to go - and the outlines ride the same transform as the pixels they are about.
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const zoom = useZoomPan(viewportRef, viewportRef, store.layerSize ?? NO_SIZE);

  if (store.status === 'loading' || store.status === 'analysing') {
    return (
      <Page fill>
        <PageHead withSidebarButton />
        <div {...stylex.props(styles.status)}>
          <Spinner />
          <Text variant="muted">{MergePageStrings.analysing(store.progress)}</Text>
          <Button onClick={presenter.cancel}>{MergePageStrings.cancel()}</Button>
        </div>
      </Page>
    );
  }

  if (store.status === 'error') {
    return (
      <Page>
        <PageHead withSidebarButton />
        <EmptyState>
          <Text as="p" variant="muted">
            {store.loadError ?? MergePageStrings.couldNotAnalyse()}
          </Text>
        </EmptyState>
      </Page>
    );
  }

  const width = store.layerSize?.width ?? 0;
  const height = store.layerSize?.height ?? 0;
  const scale = store.layerScale;
  const atRecipe = (client: Point): Point => {
    const inFrame = framePointOf(
      { x: client.x - origin.current.left, y: client.y - origin.current.top },
      zoom.view,
      zoom.box,
      store.layerSize ?? NO_SIZE,
    );
    return { x: inFrame.x / scale.x, y: inFrame.y / scale.y };
  };

  const onStageDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const bounds = event.currentTarget.getBoundingClientRect();
    origin.current = { left: bounds.left, top: bounds.top };
    zoom.handlers.onPointerDown(event);
    pressedAt.current = event.isPrimary ? { x: event.clientX, y: event.clientY } : null;
    dragged.current = false;
  };
  // A press that stays put is the click on whatever is under it, and one that travelled was the
  // pan - whose release must neither open a tile nor seed one.
  const onStageUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    zoom.handlers.onPointerUp(event);
    const started = pressedAt.current;
    if (started == null) return;
    dragged.current = travelOf(event.clientX - started.x, event.clientY - started.y) > CLICK_SLOP_PX;
  };
  const onStageCancel = (event: React.PointerEvent<HTMLDivElement>): void => {
    zoom.handlers.onPointerCancel(event);
    pressedAt.current = null;
  };
  // Clicks on a piece or inside the popup arrive here too, and are theirs.
  const onStageClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    const started = pressedAt.current;
    pressedAt.current = null;
    if (started == null || dragged.current || dismissing.current || store.readOnly) return;
    if ((event.target as Element).closest('[data-piece], [role="dialog"]') != null) return;
    presenter.seed(atRecipe({ x: event.clientX, y: event.clientY }));
  };

  const save = async (): Promise<void> => {
    if (store.recipe == null || committing) return;
    setCommitting(true);
    try {
      const saved = photoId != null ? await presenter.commitExisting(photoId) : await presenter.commit();
      navigate(photoPath(saved.photoId, source));
    } catch (err) {
      toasts.showError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  };

  // Cancelling an edit is "stop editing", not "undo the merge", so a reopened assembly leaves by
  // its own photograph and a fresh draft by the grid the selection was made in.
  const cancel = (): void => {
    presenter.discard();
    if (photoId != null) navigate(photoPath(photoId, source));
    else navigate(source == null ? '/' : collectionPath(source));
  };

  return (
    <Page fill>
      {/* The editor's bar, in the editor's order: the way out and the way to keep it first, then
          the history, then whatever this page has of its own. */}
      <Row {...DRAGS_WINDOW} style={styles.nav}>
        <ShowSidebarButton />
        <Button onClick={cancel}>{MergePageStrings.cancel()}</Button>
        <Button variant="primary" disabled={committing || store.readOnly} onClick={() => void save()}>
          {MergePageStrings.save()}
        </Button>
        <Button
          aria-label={MergePageStrings.undo()}
          tooltip={MergePageStrings.undo()}
          disabled={store.readOnly || !store.canUndo}
          onClick={presenter.undo}
        >
          <Undo2 size={ICON} />
          {MergePageStrings.undo()}
        </Button>
        <Button
          aria-label={MergePageStrings.redo()}
          tooltip={MergePageStrings.redo()}
          disabled={store.readOnly || !store.canRedo}
          onClick={presenter.redo}
        >
          <Redo2 size={ICON} />
          {MergePageStrings.redo()}
        </Button>
        <Button
          variant={store.showingLines ? 'primary' : 'default'}
          onClick={presenter.toggleLines}
          aria-pressed={store.showingLines}
        >
          {MergePageStrings.toggleTileLines()}
        </Button>
        <Button
          variant={store.removing ? 'primary' : 'default'}
          onClick={presenter.toggleRemoving}
          aria-pressed={store.removing}
          disabled={store.readOnly}
        >
          <Eraser size={ICON} />
          {MergePageStrings.removeObjects()}
        </Button>
        <div {...stylex.props(styles.blend)}>
          <Text variant="muted">{MergePageStrings.blend()}</Text>
          <Slider
            style={styles.blendSlider}
            value={store.feather * 100}
            min={0}
            max={MOST_FEATHER * 100}
            step={0.05}
            label={MergePageStrings.blend()}
            disabled={store.readOnly}
            valueText={MergePageStrings.blendPercent}
            onChange={(percent) => presenter.setFeather(percent / 100)}
            onCommit={(percent) => presenter.settleFeather(percent / 100)}
          />
        </div>
        {store.readOnly && (
          <Text variant="muted">{MergePageStrings.readOnlyMissingSources(store.missingSources)}</Text>
        )}
        <Spacer />
        <div {...stylex.props(styles.tools)}>
          {store.unaligned && (
            <Tooltip label={MergePageStrings.unaligned()}>
              <span {...stylex.props(styles.unaligned)} role="img" aria-label={MergePageStrings.unaligned()}>
                <TriangleAlert size={ICON} />
              </span>
            </Tooltip>
          )}
          <ZoomControl zoom={zoom} variant="default" />
        </div>
      </Row>

      <div {...stylex.props(stageStyles.stage, styles.stage)}>
        <div
          ref={viewportRef}
          {...stylex.props(stageStyles.viewport, !store.readOnly && styles.seeding)}
          role="region"
          aria-label={PhotoStageStrings.stage()}
          onPointerDown={onStageDown}
          onPointerMove={zoom.handlers.onPointerMove}
          onPointerUp={onStageUp}
          onPointerCancel={onStageCancel}
          onClick={onStageClick}
        >
          {/* The canvas and its overlay under one transform, each fitted into the viewport the same
              way - `object-fit: contain` and an SVG's own `xMidYMid meet` are the same letterbox -
              so an outline lands on the pixels it is about at every scale. */}
          <div
            {...stylex.props(styles.view)}
            style={{ transform: `translate(${zoom.view.x}px, ${zoom.view.y}px) scale(${zoom.view.scale})` }}
          >
            <canvas ref={handCanvas} {...stylex.props(styles.layer, styles.canvas)} />
            <svg {...stylex.props(styles.layer)} viewBox={`0 0 ${width} ${height}`}>
              {store.pieces.map(({ tile, d }, piece) =>
                tile == null ?
                  <path
                    key={piece}
                    d={d}
                    vectorEffect={NON_SCALING}
                    {...stylex.props(styles.piece, !store.showingLines && styles.quiet, styles.inert)}
                  />
                : <path
                    key={piece}
                    d={d}
                    vectorEffect={NON_SCALING}
                    data-piece={piece}
                    {...stylex.props(
                      styles.piece,
                      !store.showingLines && styles.quiet,
                      store.hoveredTile === tile && styles.hovered,
                    )}
                    role="button"
                    aria-label={MergePageStrings.tileLabel(tile)}
                    onMouseEnter={() => presenter.hoverTile(tile)}
                    onMouseLeave={() => presenter.hoverTile(null)}
                    onClick={() => {
                      if (dragged.current || dismissing.current) return;
                      presenter.openTile(tile);
                    }}
                  />,
              )}
            </svg>
          </div>

          {store.openTile != null && (
            <MergeTilePopup
              store={store}
              presenter={presenter}
              tile={store.openTile}
              zoom={zoom}
              onClose={() => presenter.openTile(null)}
            />
          )}
        </div>
      </div>
    </Page>
  );
});
