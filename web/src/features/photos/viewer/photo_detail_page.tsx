import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  GalleryThumbnails,
  Info,
} from 'lucide-react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { readSetting, writeSetting } from '../../../app/local_setting';
import {
  useListingStore,
  usePresenters,
  useStacksStore,
  useViewerStore,
} from '../../../app/stores_context';
import { useIsMobile, useIsTouch } from '../../../app/device';
import { Button } from '../../../ui/button';
import { EmptyState } from '../../../ui/empty_state';
import { ICON } from '../../../ui/icon';
import { Page } from '../../../ui/page';
import { Panel } from '../../../ui/panel';
import { Row } from '../../../ui/row';
import { Text } from '../../../ui/text';
import { RawEditPanel } from '../../raw_edit/raw_edit_panel';
import { RawEditPanelStrings } from '../../raw_edit/raw_edit_panel.strings';
import { CropStore } from '../../raw_edit/crop/crop_store';
import { EditStore } from '../../raw_edit/edit/edit_store';
import { KeystoneStore } from '../../raw_edit/keystone/keystone_store';
import { LoupeStore } from '../../raw_edit/loupe/loupe_store';
import { RepairStore } from '../../raw_edit/repair/repair_store';
import { PrintStore } from '../../raw_edit/print/print_store';
import { PrintControls } from '../../raw_edit/print/print_controls';
import { RawEditPresenter } from '../../raw_edit/stage/raw_edit_presenter';
import { RawEditStage } from '../../raw_edit/stage/raw_edit_stage';
import { StageStore } from '../../raw_edit/stage/stage_store';
import { toggleFullscreenOf } from './fullscreen';
import { PhotoDetailStrings } from './photo_detail_page.strings';
import { sourceOfPath } from '../photos_store';
import { StripViewPresenter } from './strip_view_presenter';
import { StripViewStore } from './strip_view_store';
import { panelEdge, stripEdge } from './viewer_edges';
import { styles } from './photo_detail_page.stylex';
import { PhotoTriage } from './detail_triage';
import { DetailNav } from './detail_nav';
import { DetailFrame } from './detail_frame';
import { DetailNotes } from './detail_notes';
import { DetailFilmstrip, type StripView } from './detail_filmstrip';
import {
  CameraPanel,
  PhotoEdits,
  PhotoRating,
  RawPanel,
  RenditionPanel,
} from './detail_panels';
import { DetailKeys } from './detail_keys';
import { detailMode, detailPath, isPrintRequest, mockupPath, type DetailMode } from './detail_mode';
import { isPrintProof, type SoftProof } from '../../raw_edit/proof/soft_proof';
import { TonemapChoice } from '../../raw_edit/print/print_panel';
import { PrintPanelStrings } from '../../raw_edit/print/print_panel.strings';

const EDIT_LONG_EDGE = 0;

const PANELS_KEY = 'bowerbird.detail.panels';

const STRIP_KEY = 'bowerbird.detail.filmstrip';

// Nothing but the layout and what decides it, so the page itself re-renders once
// per photo rather than on everything each part of it watches.
export const PhotoDetailPage = observer(function PhotoDetailPage(): JSX.Element {
  const { photoId = '' } = useParams();
  const store = useViewerStore();
  const listing = useListingStore();
  const stacks = useStacksStore();
  const { photos, appSettings } = usePresenters();
  const mobile = useIsMobile();
  const touch = useIsTouch();
  // Kept across photos: opened once to read a frame's settings, the reader means
  // to read the next one's too.
  const [sheetOpen, setSheetOpen] = useState(false);
  // Same on the wide layout, where the bar's info button hides the whole column
  // and gives its width back to the photograph. Off by default: the photograph is
  // the job, and the panels are opt-in. Remembered across visits once toggled.
  const [panelsOpen, setPanelsOpen] = useState(() => readSetting(PANELS_KEY) === '1');
  // The same, for the strip along the foot. Off by default for the reason the
  // panels are: what the viewer is for is the photograph.
  const [stripOpen, setStripOpen] = useState(() => readSetting(STRIP_KEY) === '1');
  // Here rather than inside the strip, because how thick it is drawn is what
  // decides which edge it goes on, and the edge is the page's to decide. Built
  // whether or not the strip is open: a store nobody has mounted watches nothing.
  const [strip] = useState<StripView>(() => {
    const view = new StripViewStore(listing, stacks, store);
    return { view, presenter: new StripViewPresenter(view, photos) };
  });
  // The stage draws its own controls into a slot in the bar, so the readout can
  // follow a wheel zoom frame by frame without the page moving with it. State
  // rather than a ref, because the stage has to render again once the slot
  // exists; the setter is stable, so neither part of the bar re-renders after.
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);
  // The same, for the zoom's range: it lives in the bar's menu, so the slot comes
  // and goes with the popup and is null whenever that is shut.
  const [zoomSlot, setZoomSlot] = useState<HTMLDivElement | null>(null);
  // State rather than a ref: the box is mounted and unmounted under this same
  // component (the not-found branch below), and an effect keyed on a ref would
  // not hear about it either way.
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  // The stage itself, which is what goes fullscreen. State rather than a ref for
  // the same reason `box` is: it is mounted and unmounted under this component,
  // by the editor as much as by the not-found branch.
  const [stage, setStage] = useState<HTMLDivElement | null>(null);
  const { pathname, search, state } = useLocation();
  const navigate = useNavigate();
  // Which print the mockup was asked for, carried on the navigation; a deep link is the sheet.
  // Through a ref, so asking for the other one from inside the mockup is not a second open.
  const requestedPrint = useRef<SoftProof>('print3d');
  requestedPrint.current = isPrintRequest(state) ? state.proof : 'print3d';
  // In the address rather than in state, because the address is the one thing stepping
  // already changes: `useStep` navigates to a bare photo path, so walking away drops `?edit`
  // and there is nothing left to go stale.
  //
  // Held as state instead, remembered against the photo it was opened for, the flag is
  // masked while the reader is elsewhere but never cleared - so stepping to the next
  // photograph and back re-enters an editor nobody asked for, each re-entry another
  // full-sensor decode.
  //
  // `?edit` still lands a deep link (and e2e) straight in, and so does `/mockup`.
  const mode = detailMode(pathname, search);
  // The photograph's own path, so the controls below build from it rather than from
  // whatever mode is open: `?edit` under `/mockup` is a URL for nothing.
  const photoPathname = detailPath(pathname);
  const editing = mode === 'edit';
  const previewing = mode !== 'view';
  const [heldSession, setSession] = useState<{
    photoId: string;
    mode: Exclude<DetailMode, 'view'>;
    touch: boolean;
    edit: EditStore;
    stage: StageStore;
    crop: CropStore;
    keystone: KeystoneStore;
    repair: RepairStore;
    loupe: LoupeStore;
    print: PrintStore;
    presenter: RawEditPresenter;
  } | null>(null);
  const session = heldSession?.photoId === photoId && heldSession.mode === mode ? heldSession : null;

  useEffect(() => {
    void photos.openDetail(photoId, sourceOfPath(pathname));
    void appSettings.load();
  }, [photoId, pathname, photos, appSettings]);

  // The one input the edges cannot get from the store. **The frame, not the
  // stage's own box**: the frame is the page's whole remaining space either way,
  // where the box inside it is whatever the strip and the panels have left - and a
  // measurement that answers the question it was taken under is a layout that
  // oscillates (`viewer_edges.ts`). Measured a little large for the stage as a
  // result, which is the same approximation the panels' own cap already is.
  useEffect(() => {
    if (box == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry == null) return;
      photos.setDetailBox(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, [box, photos]);

  // Built only while editing. The pair owns a GPU device and the frame's texture, which
  // belong to this visit rather than to the session.
  // Layout effect so the stage mounts before paint - otherwise Edit shows one
  // frame of the stored rendition beside empty panels.
  useLayoutEffect(() => {
    if (mode === 'view') return;
    const edit = new EditStore();
    const stage = new StageStore(edit);
    const crop = new CropStore(stage, edit);
    const keystone = new KeystoneStore(stage, edit, crop);
    const repair = new RepairStore(edit, keystone);
    const loupe = new LoupeStore(crop, keystone, repair);
    const print = new PrintStore();
    const presenter = new RawEditPresenter(edit, stage, crop, keystone, repair, loupe, print);
    // Before the proof, so a sheet opens as this device's rather than as the desktop's and then turns into it.
    presenter.print.setTouch(touch);
    if (mode === 'print') presenter.setSoftProof(requestedPrint.current);
    else presenter.restoreSoftProof();
    setSession({ photoId, mode, touch, edit, stage, crop, keystone, repair, loupe, print, presenter });
    let startingRotation: number | null = null;
    void presenter.open(photoId, mode === 'print' ? 'rendition' : EDIT_LONG_EDGE).then(() => {
      startingRotation = edit.doc?.rotate ?? 0;
    });
    return () => {
      presenter.close();
      setSession(null);
      // The editor saves through its own store, so the copy the Edits panel holds is behind
      // by however much was changed here.
      if (mode === 'edit') photos.forgetEdits(photoId, startingRotation != null && startingRotation !== edit.doc?.rotate);
    };
  }, [mode, photoId, photos, touch]);

  // Both replace, so opening and closing the editor leaves the history where it found it:
  // one entry for this photograph, and Back goes wherever the photograph was reached from.
  // Which is what it did when edit mode was state and the address never moved.
  //
  // Pushing on the way in reads better - Back would leave the editor - but it costs a dead
  // press: the entry the way out replaces is then identical to the one already behind it, so
  // the first Back after Done or Escape does nothing at all.
  const startEdit = useCallback(
    () => navigate(`${photoPathname}?edit`, { replace: true }),
    [navigate, photoPathname],
  );
  const stopPreview = useCallback(
    () => navigate(photoPathname, { replace: true }),
    [navigate, photoPathname],
  );
  const showsHdr = store.showsHdr(photoId);
  const proof: SoftProof = session != null ? session.stage.softProof : store.proofOf(photoId);
  const proofAs = (next: SoftProof): void => {
    if (mode === 'edit' || (mode === 'print' && isPrintProof(next))) {
      session?.presenter.setSoftProof(next);
      return;
    }
    if (isPrintProof(next)) {
      // Motion permission must be requested before this click's user activation ends.
      flushSync(() => navigate(mockupPath(photoPathname), { replace: true, state: { proof: next } }));
      return;
    }
    photos.chooseProof(next === 'hdr' ? 'hdr' : 'srgb');
    // The operator is the one thing an sRGB proof of an HDR frame asks, and it is in the panels.
    if (next === 'srgb' && showsHdr && !panelsOpen && !mobile) togglePanels();
    if (mode === 'print') navigate(photoPathname, { replace: true });
  };

  function togglePanels(): void {
    setPanelsOpen((was) => {
      const next = !was;
      writeSetting(PANELS_KEY, next ? '1' : '0');
      return next;
    });
  }

  function toggleStrip(): void {
    setStripOpen((was) => {
      const next = !was;
      writeSetting(STRIP_KEY, next ? '1' : '0');
      return next;
    });
  }

  // Only once the read for *this* photo has come back empty. The fetch starts in
  // an effect, so the render that first sees a new id has nothing loaded and
  // nothing in flight - which read as "not found" and tore the whole page down,
  // stage included, for the frame before the effect ran.
  //
  // Edit mode is exempt: e2e opens a missing id under `?edit` so the editor's
  // own failure path (not the detail fetch's) is what surfaces the reason.
  const open = store.open;
  if (open?.id === photoId && open.status === 'missing' && !previewing) {
    return (
      <Page>
        <EmptyState title={PhotoDetailStrings.photoUnavailable()}>
          <Text as="p" variant="muted">
            {open.error}
          </Text>
        </EmptyState>
      </Page>
    );
  }

  // Whichever edge leaves the photograph biggest in the box they share. The
  // photo's shape alone cannot answer it: a 3:2 frame has width to spare on a
  // 16:9 screen and none at all in a portrait window.
  //
  // The shape is off the loaded grid row when the detail has not arrived: it is
  // all the layout needs, and waiting for the fetch to learn it costs a frame of
  // empty stage on every step, warmed neighbour or not.
  const shape = store.photoFor(photoId);
  const aspect = shape == null ? null : shape.width / shape.height;
  // The strip first, over the whole frame: it spans the frame either way, and the
  // panels lay out inside what it leaves. So opening the panels never moves it -
  // which is the point, since a strip costs a third of what their column does and
  // the edge that is wrong for them is routinely the right one for it.
  const stripAxis = aspect == null ? 'below' : stripEdge(aspect, store.detailWidth, store.detailHeight, strip.view.thickness);
  // The phone's strip is inside the detail grid rather than around it, and its panels
  // are a sheet: neither takes a slice off the other there.
  const stripTaken = !mobile && stripOpen && !previewing ? { edge: stripAxis, thickness: strip.view.thickness } : null;
  const edge = aspect == null ? 'beside' : panelEdge(aspect, store.detailWidth, store.detailHeight, stripTaken);
  // Beside, the column runs the full height of the page, so every row fits
  // without scrolling; below, it is a 34vh strip and does not, and neither does
  // a phone's sheet.
  const expanded = !mobile && edge === 'beside';
  const mobileStrip = mobile && stripOpen && !previewing;
  const mobilePreview = previewing && (mobile || touch);
  const layout = mobile || mobilePreview ? 'sheet' : !panelsOpen && !previewing ? 'only' : edge;
  // The panels' grid gap is all the spacing between them beside and below the stage.
  const panelStyle = mobile ? undefined : styles.panelFlush;

  const printNotice = session != null && session.stage.status !== 'live' ? (
    <Panel>
      <Text as="p" variant={session.stage.status === 'failed' ? 'muted' : 'mono'}>
        {session.stage.message === '' ? RawEditPanelStrings.status(session.stage.status) :
          RawEditPanelStrings.statusWithMessage(RawEditPanelStrings.status(session.stage.status), session.stage.message)}
      </Text>
    </Panel>
  ) : null;
  const metaPanels = mode === 'print' ? (
    session != null && (
      <PrintControls
        proof={session.stage.softProof}
        store={session.print}
        presenter={session.presenter.print}
        disabled={!session.stage.live}
        mobile={mobile || touch}
        notice={printNotice}
      />
    )
  ) : editing ? (
    session != null && (
      <RawEditPanel
        key={photoId}
        edit={session.edit}
        stage={session.stage}
        crop={session.crop}
        keystone={session.keystone}
        repair={session.repair}
        print={session.print}
        presenter={session.presenter}
        mobile={mobile || touch}
      />
    )
  ) : (
    <>
      {showsHdr && proof === 'srgb' && (
        <Panel title={PrintPanelStrings.highlights()} style={panelStyle}>
          <TonemapChoice value={store.proofTone} onChange={photos.chooseProofTone} regional={false} />
        </Panel>
      )}
      <DetailNotes photoId={photoId} style={panelStyle} />
      <PhotoEdits photoId={photoId} defaultOpen={expanded} style={panelStyle} />
      <CameraPanel photoId={photoId} defaultOpen={expanded} style={panelStyle} />
      <RenditionPanel photoId={photoId} defaultOpen={expanded} style={panelStyle} />
      <RawPanel photoId={photoId} defaultOpen={expanded} style={panelStyle} />
    </>
  );

  // On a phone the photograph is the page. Everything the cull needs on every
  // frame is one bar pinned to the window - the verdict, and the way to the
  // rest - so a thumb finds it in the same place whatever shape the photo is,
  // and the metadata is a fold above it rather than a column stealing the
  // screen. Desktop keeps the verdict in the header instead, so hiding the
  // panels never takes the cull controls with them.
  const panels = mobilePreview ? metaPanels : mobile ? (
    <div
      {...stylex.props(styles.sheetBar)}
      role="region"
      aria-label={PhotoDetailStrings.details()}
    >
      {sheetOpen && (
        <div {...stylex.props(styles.panels, styles.panelsInSheet)}>
          {!editing && (
            <Panel>
              <PhotoRating photoId={photoId} />
            </Panel>
          )}
          {metaPanels}
        </div>
      )}

      {!editing && (
        <Row>
          <div {...stylex.props(styles.verdictControl)}>
            <PhotoTriage photoId={photoId} stretch />
          </div>
          <Button
            iconOnly
            aria-label={stripOpen ? PhotoDetailStrings.hideFilmstrip() : PhotoDetailStrings.showFilmstrip()}
            aria-expanded={stripOpen}
            title={stripOpen ? PhotoDetailStrings.hideFilmstrip() : PhotoDetailStrings.showFilmstrip()}
            onClick={toggleStrip}
          >
            <GalleryThumbnails size={ICON} />
          </Button>
          <Button
            iconOnly
            aria-label={sheetOpen ? PhotoDetailStrings.hideMetadata() : PhotoDetailStrings.showMetadata()}
            aria-expanded={sheetOpen}
            title={sheetOpen ? PhotoDetailStrings.hideMetadata() : PhotoDetailStrings.showMetadata()}
            onClick={() => setSheetOpen(!sheetOpen)}
          >
            <Info size={ICON} />
          </Button>
        </Row>
      )}
    </div>
  ) : (
    <div
      {...stylex.props(styles.panels, layout === 'below' && styles.panelsBelow)}
      role="region"
      aria-label={PhotoDetailStrings.details()}
    >
      {metaPanels}
    </div>
  );

  return (
    <Page style={styles.page}>
      <DetailKeys photoId={photoId} mode={mode} onExitPreview={stopPreview} />
      <DetailNav
        photoId={photoId}
        toolsRef={setToolsSlot}
        panelsOpen={mobile ? null : panelsOpen}
        onTogglePanels={togglePanels}
        // A phone's toggle is in the sheet beside the verdict, where its thumb
        // already is; none in the editor, where stepping away mid-grade is not
        // something to leave one press from.
        stripOpen={mobile || previewing ? null : stripOpen}
        onToggleStrip={toggleStrip}
        onEdit={startEdit}
        onDone={stopPreview}
        proof={proof}
        hdrOffered={mode === 'edit' || showsHdr}
        onProof={proofAs}
        onFullscreen={() => void toggleFullscreenOf(stage)}
        zoomRef={setZoomSlot}
        mode={mode}
        edit={session}
      />

      <div
        ref={setBox}
        {...stylex.props(styles.frame, stripAxis === 'below' ? styles.frameBelow : styles.frameBeside)}
      >
        <div
          {...stylex.props(
            styles.detail,
            styles[layout],
            layout === 'sheet' && mobileStrip && styles.sheetStrip,
          )}
        >
          {previewing ? (
            // Nothing until the pair exists, rather than the viewer's stage for the render
            // before the layout effect runs: its elements ask for this photograph's rendition
            // with nothing painted, and mount both neighbours' as soon as one of them decodes.
            //
            // The same slot the viewer's stage draws into, so the zoom control sits where it
            // always sits rather than moving when the reader opens the editor.
            //
            // **Keyed, because the canvas belongs to the worker once it has been handed over.**
            // `transferControlToOffscreen` is permanent and throws on a second call, and stepping
            // between two `?edit` addresses rebuilds the pair without React ever seeing a null
            // session - so an unkeyed stage would hand the *new* presenter an element the *old*
            // worker already owns, and the editor would open failed for good.
            session != null && (
              <RawEditStage
                key={`${session.photoId}:${session.mode}:${session.touch}`}
                stageStore={session.stage}
                crop={session.crop}
                keystone={session.keystone}
                repair={session.repair}
                loupe={session.loupe}
                print={session.print}
                presenter={session.presenter}
                toolsInto={toolsSlot}
                zoomInto={zoomSlot}
                fullscreenRef={setStage}
              />
            )
          ) : (
            <DetailFrame photoId={photoId} toolsInto={toolsSlot} zoomInto={zoomSlot} fullscreenRef={setStage} />
          )}
          {/* Along the foot whatever shape the phone is in: the sheet is the bottom of
              the window, so a strip down the side of it would be a column an inch wide.
              A row of the grid rather than part of the sheet above it, so the photograph
              shrinks to make room instead of being covered. */}
          {mobileStrip && <DetailFilmstrip photoId={photoId} strip={strip} edge="below" />}
          {(mobile || panelsOpen || previewing) && panels}
        </div>

        {/* Outside the panels, so it spans them: whichever axis still has room
            once they have taken theirs is the one to spend on the strip. */}
        {stripOpen && !mobile && !previewing && <DetailFilmstrip photoId={photoId} strip={strip} edge={stripAxis} />}
      </div>
    </Page>
  );
});
