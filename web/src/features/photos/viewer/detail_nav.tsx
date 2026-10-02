import * as stylex from '@stylexjs/stylex';
import {
  AppWindow,
  ArrowLeft,
  Bug,
  Camera,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FileType,
  FolderOpen,
  GalleryThumbnails,
  HardDriveDownload,
  Info,
  Layers,
  Layers2,
  Maximize,
  Maximize2,
  RefreshCw,
  Redo2,
  RotateCcw,
  RotateCw,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Undo2,
  Wand2,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Link, useNavigate } from 'react-router-dom';
import { type ViewerRendition } from '../../../../../src/schemas/settings';
import { canOpenOriginalWith, canRevealFile, opensWithAMenu } from '../../../api/transport';
import { useIsMobile, useIsTouch } from '../../../app/device';
import {
  useLibrariesStore,
  useListingStore,
  usePresenters,
  useReplicationStore,
  useViewerStore,
} from '../../../app/stores_context';
import { Button } from '../../../ui/button';
import { CLEARS_CAPTION_BUTTONS } from '../../../ui/caption_buttons';
import { ICON } from '../../../ui/icon';
import { menuSection } from '../../../ui/menu_section';
import { menuStyles } from '../../../ui/menu_styles';
import type { Option } from '../../../ui/option';
import { OverflowMenu } from '../../../ui/overflow_menu';
import { ShowSidebarButton } from '../../../ui/page';
import { DRAGS_WINDOW } from '../../../ui/title_bar';
import { Row, Spacer } from '../../../ui/row';
import { Text } from '../../../ui/text';
import { SendToFrameTv } from '../../frame_tv/send_to_frame_tv';
import { EditToolbar } from '../../raw_edit/edit_tools';
import { EditToolsStrings } from '../../raw_edit/edit_tools.strings';
import type { EditStore } from '../../raw_edit/edit/edit_store';
import type { LoupeStore } from '../../raw_edit/loupe/loupe_store';
import type { RawEditPresenter } from '../../raw_edit/stage/raw_edit_presenter';
import type { StageStore } from '../../raw_edit/stage/stage_store';
import { bugReporter } from '../../feedback/report_bug';
import { ReportBugStrings } from '../../feedback/report_bug_dialog.strings';
import type { SoftProof } from '../../raw_edit/proof/soft_proof';
import { SoftProofMenu, softProofOptions } from '../../raw_edit/proof/soft_proof_menu';
import { SoftProofMenuStrings } from '../../raw_edit/proof/soft_proof_menu.strings';
import { BulkBarStrings } from '../grid/bulk_bar.strings';
import { isComposite, mergeEditPath, triagePath } from '../photos_store';
import { renditionLabel } from '../renditions';
import { DetailRating } from './detail_rating';
import type { DetailMode } from './detail_mode';
import { nameOf, useStep } from './detail_navigation';
import { PhotoDetailStrings } from './photo_detail_page.strings';
import { styles } from './photo_detail_page.stylex';
import { PhotoStageStrings } from './photo_stage.strings';
import { PhotoTriage } from './detail_triage';

// Renditions of the same frame rather than commands: each is built once and
// cached, so these read as "which one am I looking at", not "rebuild it now".
// All three stay on offer whichever is showing, including the step back down to
// the camera's JPEG: comparing a render against it is a reason to switch.
const RENDITIONS: Option<ViewerRendition>[] = [
  {
    value: 'embedded',
    label: renditionLabel('embedded'),
    icon: <Sparkles size={ICON} />,
    hint: 'I',
  },
  { value: 'full', label: renditionLabel('full'), icon: <Wand2 size={ICON} />, hint: 'O' },
  { value: 'max', label: renditionLabel('max'), icon: <Maximize2 size={ICON} />, hint: 'P' },
];

// Three ways a photograph leaves: the picture on screen into whatever else is on the device,
// the file the camera wrote, taken away or opened in another app, and everything else through
// the export dialog. The renditions are not offered as downloads - they are the viewer's own
// working copies at the viewer's own settings, where an export is a question with eight answers.
// The share is the exception, and only because sharing is a gesture about the picture in front
// of the reader.
type Send = 'share' | 'original' | 'openWith' | 'reveal' | 'export';

const DOWNLOADS: Option<Send>[] = [
  { value: 'share', label: PhotoDetailStrings.share(), icon: <Share2 size={ICON} /> },
  {
    value: 'original',
    label: PhotoDetailStrings.downloadOriginal(),
    icon: <FileType size={ICON} />,
  },
  {
    value: 'openWith',
    label: PhotoDetailStrings.openWith(),
    icon: <AppWindow size={ICON} />,
    keepsMenuOpen: typeof navigator !== 'undefined' && opensWithAMenu(),
  },
  {
    value: 'reveal',
    label: PhotoDetailStrings.openContainingFolder(),
    icon: <FolderOpen size={ICON} />,
  },
  {
    value: 'export',
    label: BulkBarStrings.exportPhotos(),
    icon: <HardDriveDownload size={ICON} />,
  },
];

// No share sheet on most desktop browsers, and a row that does nothing when pressed is worse
// than one that is not offered - the same answer `document.fullscreenEnabled` gets below. Read
// once: what a browser can do does not change under the reader.
const SHAREABLE = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function';
const OPENS_WITH = typeof navigator !== 'undefined' && canOpenOriginalWith();

function sendable(option: Option<Send>, composite: boolean): boolean {
  if (option.value === 'share') return SHAREABLE;
  // A composite has no RAW of its own to open.
  if (option.value === 'openWith') return OPENS_WITH && !composite;
  if (option.value === 'reveal') return canRevealFile() && !composite;
  return true;
}

/**
 * The renditions this photograph actually has, out of the three above.
 *
 * **A PNG, a HEIC or an AVIF has no camera JPEG in it**, and the row says so (`has_embedded`).
 * Offering it anyway sends the reader to a file that cannot exist - and worse, `chooseRendition`
 * remembers the choice, so one press poisons `last_viewer_rendition` for every photograph opened
 * afterwards. Unknown until the row lands, and the answer for almost every photograph is yes, so
 * an absent one offers all three.
 */
function offered<T extends 'original' | ViewerRendition>(
  options: Option<T>[],
  photo: { has_embedded: boolean } | null | undefined,
): Option<T>[] {
  if (photo == null || photo.has_embedded) return options;
  return options.filter((option) => option.value !== 'embedded');
}

type ViewAction = 'fullscreen' | 'rotateLeft' | 'rotateRight' | 'filmstrip';

const VIEW_ACTIONS: Option<ViewAction>[] = [
  {
    value: 'fullscreen',
    label: PhotoStageStrings.fullscreen(),
    icon: <Maximize size={ICON} />,
    hint: 'F',
  },
];

const ROTATE_ACTIONS: Option<ViewAction>[] = [
  { value: 'rotateLeft', label: EditToolsStrings.rotateLeft(), icon: <RotateCcw size={ICON} /> },
  { value: 'rotateRight', label: EditToolsStrings.rotateRight(), icon: <RotateCw size={ICON} /> },
];

type EditAction = 'undo' | 'redo' | 'cameraMatch';

type Action = 'edit' | 'editMerge' | 'metadata' | 'rerender' | 'hide' | 'delete';

// Greyed out rather than absent where a library serves the camera's JPEG: there is
// no render of its own to remake.
function actions({
  rerendering,
  renders,
  editable,
  fetchingOriginal,
  readOnly,
  unreachable,
  editHref,
  hidden,
  merged,
}: {
  rerendering: boolean;
  renders: boolean;
  editable: boolean;
  fetchingOriginal: boolean;
  /** A library that cannot take the original, which a photo that is not editable has to fetch. */
  readOnly: boolean;
  unreachable: boolean;
  editHref: string;
  /** Whether this photograph is already put away, which is which way the one hide row points. */
  hidden: boolean;
  /** A row composed out of others, which is the only kind that has a merge to go back into. */
  merged: boolean;
}): Option<Action>[] {
  return [
    // There has to be something here to open, and for a photograph that is its own file: the
    // pictures on this screen may have come from a peer's renditions (§7.9). A composite is
    // editable without one - what it opens is the canvas its recipe composes, prepared where
    // the frames are. Anything else fetches its original first, because what opening without
    // one looks like from inside the editor is a 404 with no way out of it.
    editable
      ? {
          value: 'edit',
          label: PhotoDetailStrings.edit(),
          icon: <SlidersHorizontal size={ICON} />,
          link: <Link to={editHref} replace />,
        }
      : {
          value: 'edit',
          label: fetchingOriginal
            ? PhotoDetailStrings.fetchingOriginal()
            : PhotoDetailStrings.fetchOriginalAndEdit(),
          icon: fetchingOriginal ? (
            <RefreshCw size={ICON} {...stylex.props(menuStyles.spin)} />
          ) : (
            <HardDriveDownload size={ICON} />
          ),
          disabled: fetchingOriginal || readOnly || unreachable,
          keepsMenuOpen: true,
          ...(readOnly
            ? { tooltip: BulkBarStrings.libraryIsReadOnly() }
            : unreachable
              ? { tooltip: PhotoDetailStrings.stateOnUnreachableDeviceHint() }
              : {}),
        },
    // Offered for any composite, panorama included: which kind of recipe this is is the merge
    // page's own question, and it answers it by failing to load with the server's reason rather
    // than by a field the viewer would have to carry.
    ...(merged
      ? [
          {
            value: 'editMerge' as const,
            label: PhotoDetailStrings.editMerge(),
            icon: <Layers2 size={ICON} />,
          },
        ]
      : []),
    { value: 'metadata', label: BulkBarStrings.refreshMetadata(), icon: <RotateCw size={ICON} /> },
    {
      value: 'rerender',
      label: rerendering
        ? PhotoDetailStrings.rebuildingRendition()
        : PhotoDetailStrings.rebuildRendition(),
      icon: <RefreshCw size={ICON} {...stylex.props(rerendering && menuStyles.spin)} />,
      disabled: !renders || rerendering,
    },
    {
      value: 'hide',
      label: hidden ? BulkBarStrings.unhide() : BulkBarStrings.hide(),
      icon: hidden ? <Eye size={ICON} /> : <EyeOff size={ICON} />,
    },
    {
      value: 'delete',
      label: BulkBarStrings.moveToBin(),
      icon: <Trash2 size={ICON} />,
      destructive: true,
    },
  ];
}

// Where the reader can go from here, and what can be done to the photo they are
// on.
export const DetailNav = observer(function DetailNav({
  photoId,
  toolsRef,
  panelsOpen,
  onTogglePanels,
  stripOpen,
  onToggleStrip,
  editHref,
  onDone,
  proof,
  hdrOffered,
  onProof,
  onFullscreen,
  zoomRef,
  mode,
  edit,
}: {
  photoId: string;
  /** Where the stage draws its zoom readout. */
  toolsRef: (slot: HTMLDivElement | null) => void;
  /** Where it draws the zoom's whole range, which is inside this bar's menu. */
  zoomRef: (slot: HTMLDivElement | null) => void;
  /** Null on a phone or touch editor, whose sheet owns the panels, and in the mockup. */
  panelsOpen: boolean | null;
  onTogglePanels: () => void;
  /**
   * Null where this bar is not what offers the strip: a phone's viewer, and the mockup. A phone's
   * editor offers it as a menu row.
   */
  stripOpen: boolean | null;
  onToggleStrip: () => void;
  /** Where the Edit row goes, which replaces this entry in the history rather than pushing one. */
  editHref: string;
  onDone: () => void;
  /** What the stage stands in for, and whether an HDR rendition is there to stand in for. */
  proof: SoftProof;
  hdrOffered: boolean;
  onProof: (proof: SoftProof) => void;
  onFullscreen: () => void;
  mode: DetailMode;
  /** Null until the editor's own layout effect has built the pair, one render behind `mode`. */
  edit: {
    edit: EditStore;
    stage: StageStore;
    loupe: LoupeStore;
    presenter: RawEditPresenter;
  } | null;
}): JSX.Element {
  const listing = useListingStore();
  const store = useViewerStore();
  const replicationStore = useReplicationStore();
  const libraries = useLibrariesStore();
  const { photos, export: exportPhotos, feedback, frameTv, replication, confirm } = usePresenters();
  const step = useStep();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const touch = useIsTouch();
  const photo = store.detailFor(photoId);
  const editable =
    isComposite(store.photoFor(photoId)) ||
    photo == null ||
    photo.has_original ||
    photo.is_offloaded;
  const editing = mode === 'edit';
  // The print mockup renders through the editor's session, so it takes the editor's chrome
  // rules - no rendition choice - while leaving the grade's own controls out.
  const previewing = mode !== 'view';
  const prevId = store.prevPhotoId;
  const nextId = store.nextPhotoId;
  // The grid this photo was opened from - the shoot, the album, the Bin - rather
  // than always the library.
  const back = store.openedFrom;
  // On `stack_id` alone, and not the grid tile's `stack_size > 1`: `stack_size`
  // is a property of a collapsed listing row, hardcoded to 1 on a detail and on a
  // band member, so the tile's condition would hide this on every route that
  // actually reaches the viewer from a stack. A stack has two or more members by
  // construction (§19.6).
  // Under the same collection the viewer is, so the way back out of a triage
  // session lands in the grid the reader entered it from.
  const stackPath =
    previewing || photo?.stack_id == null ? null : triagePath(photo.stack_id, listing.source);
  // A row composed rather than imported has no path to show, so the bar names it the way
  // every other view does rather than going blank.
  const path = photo == null ? '' : (photo.file_path ?? nameOf(store, photoId));

  // Editing keeps the view controls and the downloads and drops the rest: which rendition
  // the viewer shows says nothing about the frame being graded, and every other action is
  // either what the reader is already doing or a way of leaving the photograph in the
  // middle of one. How the photograph is looked at is the same question in both modes, so
  // the zoom and the fullscreen are the same controls in the same place.
  const viewActions: Option<ViewAction>[] = [
    ...(document.fullscreenEnabled ? VIEW_ACTIONS : []),
    // A turn in the mockup would rotate the photograph rather than the sheet on screen,
    // so it is not offered there.
    ...(mode === 'print'
      ? []
      : ROTATE_ACTIONS.map((option) => ({
          ...option,
          disabled: editing ? !edit?.stage.editable : !editable,
        }))),
    ...(mobile && stripOpen != null
      ? [
          {
            value: 'filmstrip' as const,
            label: PhotoDetailStrings.toggleFilmstrip(),
            icon: <GalleryThumbnails size={ICON} />,
          },
        ]
      : []),
  ];

  const undoRedo: Option<EditAction>[] = [
    {
      value: 'undo',
      label: PhotoDetailStrings.undo(),
      icon: <Undo2 size={ICON} />,
      disabled: edit == null || !edit.stage.editable || !edit.edit.canUndo,
    },
    {
      value: 'redo',
      label: PhotoDetailStrings.redo(),
      icon: <Redo2 size={ICON} />,
      disabled: edit == null || !edit.stage.editable || !edit.edit.canRedo,
    },
  ];

  const resetToCameraMatch: Option<EditAction> = {
    value: 'cameraMatch',
    label: PhotoDetailStrings.resetToCameraMatch(),
    icon: <Camera size={ICON} />,
    disabled:
      edit == null ||
      !edit.stage.editable ||
      edit.stage.cameraTone == null ||
      edit.stage.atCameraMatch,
  };
  const onEditAction = async (action: EditAction): Promise<void> => {
    if (action === 'undo') return edit?.presenter.undo();
    if (action === 'redo') return edit?.presenter.redo();
    const confirmed = await confirm.ask({
      title: PhotoDetailStrings.resetToCameraMatchQuestion(),
      body: PhotoDetailStrings.resetToCameraMatchWarning(),
      action: PhotoDetailStrings.reset(),
      tone: 'danger',
    });
    if (confirmed) edit?.presenter.resetToCameraMatch();
  };

  const editSection = editing
    ? [
        menuSection({
          label: PhotoDetailStrings.sectionEdit(),
          // A phone's bar has no width for undo and redo beside the tools.
          options: [...(mobile ? undoRedo : []), resetToCameraMatch],
          onSelect: (action) => void onEditAction(action),
        }),
      ]
    : [];

  const crowded = mobile
    ? [
        menuSection({
          label: SoftProofMenuStrings.softProof(),
          options: softProofOptions(proof, hdrOffered),
          onSelect: onProof,
        }),
      ]
    : [];

  const sections = [
    ...(mobile && !previewing && path !== ''
      ? [
          menuSection({
            content: (
              <Text variant="mono" style={styles.pathMenu}>
                {path}
              </Text>
            ),
          }),
        ]
      : []),
    ...editSection,
    ...crowded,
    menuSection({
      label: PhotoDetailStrings.sectionView(),
      content: <div ref={zoomRef} />,
      // iPhone Safari has no element fullscreen, and a row that does nothing when
      // pressed is worse than one that is not offered.
      options: viewActions,
      onSelect: (action) => {
        if (action === 'fullscreen') {
          onFullscreen();
          return;
        }
        if (action === 'filmstrip') {
          onToggleStrip();
          return;
        }
        const by = action === 'rotateLeft' ? -90 : 90;
        if (editing) edit?.presenter.turn(by);
        else void photos.turn(photoId, by);
      },
    }),
    ...(previewing
      ? []
      : [
          // Which of the three files is on screen: the comparison the detail view
          // exists for, so it leads rather than sitting under the housekeeping.
          menuSection({
            label: PhotoDetailStrings.sectionRendition(),
            options: offered(RENDITIONS, photo).map((option) => ({
              ...option,
              active: option.value === store.frameOf(photoId).rendition,
            })),
            onSelect: (rendition) => void photos.chooseRendition(photoId, rendition),
          }),
          menuSection({
            label: PhotoDetailStrings.sectionActions(),
            options: actions({
              rerendering: store.buildingRendition,
              renders: store.rerenderTarget != null,
              // A composite has no file of its own and is editable anyway: what it opens is the
              // canvas its recipe composes, prepared where its frames are. Whether *those* are on
              // this device is a stat per frame that no field here answers, so a composite whose
              // frames have gone opens and fails inside the editor with the server's reason -
              // which is worse than a disabled control and better than a bare 404.
              //
              // Everything else needs its original here or on a backup, which the editor's read
              // fetches back (§14.4). Unknown until the detail arrives, and yes for almost every
              // photograph: a library nobody replicates holds its own.
              editable,
              fetchingOriginal: replicationStore.fetching.has(photoId),
              readOnly: photo != null && libraries.byId.get(photo.library_id)?.read_only === true,
              unreachable: store.unreachable(photoId),
              editHref,
              hidden: photo?.is_hidden ?? false,
              merged: isComposite(store.photoFor(photoId)),
            }),
            onSelect: (action) => {
              if (action === 'edit') {
                void replication.fetchOriginalAndWait(photoId).then((fetched) => {
                  if (fetched && store.open?.id === photoId) navigate(editHref, { replace: true });
                });
                return;
              }
              if (action === 'editMerge') {
                navigate(mergeEditPath(photoId, listing.source));
                return;
              }
              if (action === 'delete') {
                void photos.deletePhotos({ photo_ids: [photoId] });
                return;
              }
              if (action === 'hide') {
                void photos.hidePhotos({ photo_ids: [photoId] }, photo?.is_hidden !== true);
                return;
              }
              if (action === 'rerender') {
                void photos.rerenderRenditions(photoId);
                return;
              }
              void photos.refreshMetadata({ photo_ids: [photoId] });
            },
          }),
          // The verdict is a press and stays in the bar; a rating is five targets, which the
          // bar has no width for beside the path. A phone rates from the sheet instead.
          ...(mobile
            ? []
            : [
                menuSection({
                  label: PhotoDetailStrings.rating(),
                  content: (
                    <DetailRating photoId={photoId} focusable={false} style={styles.menuRating} />
                  ),
                }),
              ]),
        ]),
    menuSection({
      label: PhotoDetailStrings.sectionSend(),
      content: <SendToFrameTv onSend={(tvId) => void frameTv.sendPhoto(photoId, tvId)} />,
      options: DOWNLOADS.filter((option) => sendable(option, isComposite(store.photoFor(photoId)))),
      onSelect: (form) => {
        if (form === 'share') {
          void photos.share(photoId);
          return;
        }
        if (form === 'openWith') {
          void photos.openWith(photoId);
          return;
        }
        if (form === 'reveal') {
          void photos.revealOriginal(photoId);
          return;
        }
        if (form === 'original') {
          photos.download(photoId, form);
          return;
        }
        // The frame the estimate is scaled against, where the detail has landed. Null is a
        // dialog that says nothing about size rather than one that guesses at it.
        const frame =
          photo?.width != null && photo.height != null
            ? { width: photo.width, height: photo.height }
            : null;
        exportPhotos.openFor({ photo_ids: [photoId] }, 1, frame);
      },
    }),
    // Here as well as in the sidebar, which the viewer hides: this is the one screen where a
    // report can carry the photograph it is about (§18.8).
    ...(bugReporter.canSend()
      ? [
          menuSection({
            label: PhotoDetailStrings.sectionHelp(),
            options: [
              {
                value: 'report' as const,
                label: ReportBugStrings.reportABug(),
                icon: <Bug size={ICON} />,
              },
            ],
            onSelect: () => feedback.openFor(photoId),
          }),
        ]
      : []),
  ];

  // A phone cannot hold the grade's bar on one line - the tools, the turns and the zoom are
  // eight controls before the menus - so while editing it is allowed the second row rather
  // than squeezing every button below its own label. Which also means dropping the centring:
  // a spacer on a wrapped line pushes the toolbar to an edge instead of the middle.
  const centred = editing && !mobile;
  const tool = edit?.loupe.tool ?? 'cursor';
  const leaveTool = (): void => edit?.presenter.setTool('cursor');

  return (
    <Row
      {...DRAGS_WINDOW}
      style={[styles.nav, editing && styles.navEditing, CLEARS_CAPTION_BUTTONS]}
      role="group"
      aria-label={PhotoDetailStrings.controls()}
    >
      <ShowSidebarButton />
      {/* The way out and the way back through the grade take the same corner: leaving is
          what the reader reaches for in either mode. */}
      {editing ? (
        <>
          <Button
            disabled={edit == null}
            onClick={() =>
              void edit?.presenter.cancel().then((restored) => {
                if (restored) onDone();
              })
            }
          >
            {PhotoDetailStrings.cancel()}
          </Button>
          {/* Inside a geometry tool this leaves the *tool*, not the editor. Same corner and
              same weight, because it is the same gesture as far as the reader is concerned -
              finish what is open - and one that closed the whole grade from under a
              half-drawn crop would be the wrong one to hit by habit. */}
          <Button variant="primary" onClick={tool === 'cursor' ? onDone : leaveTool}>
            {tool === 'crop'
              ? PhotoDetailStrings.finishCrop()
              : tool === 'perspective'
                ? PhotoDetailStrings.finishPerspective()
                : PhotoDetailStrings.done()}
          </Button>
          {!mobile &&
            undoRedo.map((option) => (
              <Button
                key={option.value}
                disabled={option.disabled}
                onClick={() =>
                  void (option.value === 'undo' ? edit?.presenter.undo() : edit?.presenter.redo())
                }
              >
                {option.icon}
                {option.label}
              </Button>
            ))}
        </>
      ) : (
        <>
          {/* Still a link, so it can be opened in a tab of its own; the cursor is put
              on this photo on the way out so the grid comes back to it. */}
          <Button render={<Link to={back.path} />} onClick={photos.focusOpenPhoto}>
            <ArrowLeft size={ICON} />
            {back.label}
          </Button>
          {!touch && (
            <>
              <Button
                iconOnly
                aria-label={PhotoDetailStrings.previousPhoto()}
                disabled={prevId == null}
                onClick={() => step('prev')}
              >
                <ChevronLeft size={ICON} />
              </Button>
              <Button
                iconOnly
                aria-label={PhotoDetailStrings.nextPhoto()}
                disabled={nextId == null}
                onClick={() => step('next')}
              >
                <ChevronRight size={ICON} />
              </Button>
            </>
          )}
          {/* The one thing in the bar that gives up width, so the controls stay on a
              single line however long a path is. A phone has no width to give it in the
              first place, so there it is a row of the menu instead. */}
          {!mobile && (
            <Text variant="mono" style={styles.path}>
              {path}
            </Text>
          )}
        </>
      )}

      {(!editing || centred) && <Spacer />}

      {/* Between two spacers where there is room for them, so the toolbar sits in the middle
          of the bar rather than on the end of whichever group happens to be longer. */}
      {editing && edit != null && (
        <EditToolbar stage={edit.stage} loupe={edit.loupe} presenter={edit.presenter} />
      )}
      {editing && <Spacer />}

      <div {...stylex.props(styles.tools)} ref={toolsRef} />

      {/* Judging lives in the bar so it survives hiding the metadata column: a cull
          with the panels away is the common case, and the verdict has to stay under
          the same fingers that step between frames. */}
      {!mobile && !previewing && <PhotoTriage photoId={photoId} />}

      {stackPath != null && (
        <Button
          iconOnly={mobile}
          aria-label={PhotoDetailStrings.triageStack()}
          tooltip={PhotoDetailStrings.triageStack()}
          onClick={() => navigate(stackPath, { state: { entryPhotoId: photoId } })}
        >
          <Layers size={ICON} />
          {!mobile && PhotoDetailStrings.triageStack()}
        </Button>
      )}

      {!mobile && <SoftProofMenu value={proof} hdrOffered={hdrOffered} onChange={onProof} />}

      {stripOpen != null && !mobile && (
        <Button
          iconOnly
          aria-label={
            stripOpen ? PhotoDetailStrings.hideFilmstrip() : PhotoDetailStrings.showFilmstrip()
          }
          aria-expanded={stripOpen}
          onClick={onToggleStrip}
        >
          <GalleryThumbnails size={ICON} />
        </Button>
      )}

      {panelsOpen != null && (
        <Button
          iconOnly
          aria-label={
            panelsOpen ? PhotoDetailStrings.hideMetadata() : PhotoDetailStrings.showMetadata()
          }
          aria-expanded={panelsOpen}
          onClick={onTogglePanels}
        >
          <Info size={ICON} />
        </Button>
      )}

      {/* Keyed on the mode: the three modes are one mounted page, so a menu kept open through a
          fetch would otherwise still be open over the editor it opened. */}
      <OverflowMenu key={mode} hotkey label={PhotoDetailStrings.more()} sections={sections} />
    </Row>
  );
});
