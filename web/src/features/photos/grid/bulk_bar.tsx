import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import {
  Download,
  Eye,
  EyeOff,
  FolderInput,
  FolderOpen,
  HardDrive,
  ImagePlus,
  Images,
  Layers,
  Layers2,
  ListChecks,
  Plus,
  RotateCcw,
  RotateCw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { canRevealFile } from '../../../api/transport';
import {
  useAlbumsStore,
  useLibrariesStore,
  useListingStore,
  useMarksStore,
  usePresenters,
  useReplicationStore,
  useShootsStore,
} from '../../../app/stores_context';
import { Button } from '../../../ui/button';
import { CheckMenu } from '../../../ui/check_menu';
import { ICON } from '../../../ui/icon';
import { menuSection } from '../../../ui/menu_section';
import type { Option } from '../../../ui/option';
import { OverflowMenu } from '../../../ui/overflow_menu';
import { Submenu } from '../../../ui/submenu';
import { Text } from '../../../ui/text';
import { color } from '../../../ui/tokens.stylex';
import { AddAlbumDialog } from '../../albums/add_album_dialog';
import { SendToFrameTv } from '../../frame_tv/send_to_frame_tv';
import { AddShootDialog } from '../../shoots/add_shoot_dialog';
import { BulkBarStrings } from './bulk_bar.strings';
import { Rating, Verdict } from '../marks';
import { MergePageStrings } from '../merge/merge_page.strings';
import { PanoramaIcon } from './panorama_icon';
import { PhotoDetailStrings } from '../viewer/photo_detail_page.strings';
import { isComposite, mergeJobPath, triagePath, type MergeCandidate, type StackSelection } from '../photos_store';

// Behind the overflow, so the bar's own row holds only what a cull does
// constantly - the verdict. The rest is reached deliberately, and most of it
// rarely, in three groups: what the selection *is*, where it is filed, and what
// can be done to the photographs themselves.
type StackAction = 'stack' | 'unstack' | 'triage';
type MergeAction = 'panorama' | 'assembly';
type FilingAction = 'remove' | 'banner';
type PhotoAction = 'export' | 'reveal' | 'thumbnails' | 'metadata' | 'hide' | 'unhide' | 'bin';

const styles = stylex.create({
  // Floating over the foot of the viewport, out of the flow: in the flow its arrival moved every
  // tile below it by a bar's height mid-gesture (§18.3.1).
  bar: {
    position: 'fixed',
    left: '50%',
    bottom: 'calc(16px + env(safe-area-inset-bottom))',
    transform: 'translateX(-50%)',
    zIndex: 5,
    maxWidth: 'calc(100vw - 24px)',
    backgroundColor: color.slateSoft,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: '6px',
    paddingBlock: '8px',
    paddingInline: '10px',
    boxShadow: '0 12px 32px rgb(0 0 0 / 0.55)',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  count: {
    color: color.glass,
  },
  // A section's own control rather than one of its rows, so it takes the items' text column.
  menuRating: {
    paddingTop: '4px',
    paddingInline: '9px',
    paddingBottom: '6px',
  },
});

// Beside the ids in the shoot and album submenus, which are never empty.
const NEW_COLLECTION = '';

// Not the come-and-go of Stack and Unstack below: a session wants one whole stack
// and nothing else, so the row that is refusing has to stay and say so.
function triageRefusal(stack: StackSelection): string | undefined {
  switch (stack.kind) {
    case 'stack':
      return undefined;
    case 'none':
      return BulkBarStrings.selectAStack();
    case 'partial':
      return BulkBarStrings.selectWholeStack();
    case 'extra':
      return BulkBarStrings.selectOneStack();
  }
}

// Each refusal is its own line rather than one combined message, so a reader who fixes the first
// thing wrong sees which one is next rather than the whole list at once.
function mergeRefusal(candidate: MergeCandidate): string | undefined {
  switch (candidate.kind) {
    case 'ready':
      return undefined;
    case 'unresolved':
      return MergePageStrings.loadTheSelectionFirst();
    case 'tooFew':
      return MergePageStrings.selectAtLeastTwo();
    case 'tooMany':
      return MergePageStrings.selectTwelveOrFewer();
    case 'mixedLibraries':
      return MergePageStrings.selectOneLibrary();
    case 'hasComposite':
      return MergePageStrings.cannotMergeAComposite();
  }
}

// Stack and Unstack come and go rather than greying out, because they are not
// "this action, once you have a selection" but statements about what the
// selection *is*: two photographs to fuse, or a stack in it to take apart. Both
// at once for a selection holding both.
const stackOptions = ({
  canStack,
  canUnstack,
  stack,
}: {
  canStack: boolean;
  canUnstack: boolean;
  stack: StackSelection;
}): Option<StackAction>[] => [
  ...(canStack ? [{ value: 'stack' as const, label: BulkBarStrings.stack(), icon: <Layers size={ICON} /> }] : []),
  ...(canUnstack ? [{ value: 'unstack' as const, label: BulkBarStrings.unstack(), icon: <Layers2 size={ICON} /> }] : []),
  {
    value: 'triage',
    label: BulkBarStrings.triageThisStack(),
    icon: <ListChecks size={ICON} />,
    disabled: stack.kind !== 'stack',
    tooltip: triageRefusal(stack),
  },
];

const filingOptions = ({
  removeFrom,
  removeRefusal,
  banner,
}: {
  removeFrom: string | null;
  removeRefusal: string | undefined;
  /** Absent outside a shoot or an album, which are the only things with a thumbnail to set. */
  banner: string | null;
}): Option<FilingAction>[] => [
  ...(removeFrom == null ?
    []
  : [
      {
        value: 'remove' as const,
        label: removeFrom,
        icon: <X size={ICON} />,
        disabled: removeRefusal != null,
        tooltip: removeRefusal,
      },
    ]),
  ...(banner == null ? [] : [{ value: 'banner' as const, label: banner, icon: <ImagePlus size={ICON} /> }]),
];

// The Bin entry says how many photographs it is about, because it is the one here
// the reader has to be sure of before they pick it and the only one they reach
// from behind a menu, with the tiles it is about out of sight - and a stack row
// stands for several, so the selection on screen does not say the number either.
// Both directions, always, rather than one row pointing whichever way the grid is: Hidden is a chip
// like any other (§12.4), so a grid can hold the put-away beside the live and a selection across it
// is mixed. A row that guessed from the grid's filters would be the wrong one for half of it, and
// the selection can reach rows this client has never held, so there is nothing to guess from either.
const photoOptions = (bin: string, revealable: boolean): Option<PhotoAction>[] => [
  { value: 'export', label: BulkBarStrings.exportPhotos(), icon: <Download size={ICON} /> },
  ...(revealable ?
    [{ value: 'reveal' as const, label: PhotoDetailStrings.openContainingFolder(), icon: <FolderOpen size={ICON} /> }]
  : []),
  { value: 'thumbnails', label: BulkBarStrings.rebuildThumbnails(), icon: <Sparkles size={ICON} /> },
  { value: 'metadata', label: BulkBarStrings.refreshMetadata(), icon: <RotateCw size={ICON} /> },
  { value: 'hide', label: BulkBarStrings.hide(), icon: <EyeOff size={ICON} /> },
  { value: 'unhide', label: BulkBarStrings.unhide(), icon: <Eye size={ICON} /> },
  { value: 'bin', label: bin, icon: <Trash2 size={ICON} />, destructive: true },
];

function bannerLabel(kind: 'shoot' | 'album', single: boolean): string {
  if (kind === 'shoot') return single ? BulkBarStrings.setShootThumbnail() : BulkBarStrings.setFirstAsShootThumbnail();
  return single ? BulkBarStrings.setAlbumThumbnail() : BulkBarStrings.setFirstAsAlbumThumbnail();
}

interface Props {
  // Set on a shoot or album page: the collection the grid *is*, which the
  // selection can be removed from and can become the thumbnail of.
  collection?: { kind: 'shoot' | 'album'; id: string; name: string };
}

// Bulk actions for the current selection: a bar floating over the foot of the
// viewport, drawn only while something is selected (§18.3.1). Out of the flow, so
// it arriving takes no space from the grid and moves nothing under the pointer.
export const BulkBar = observer(function BulkBar({ collection }: Props): JSX.Element | null {
  const listing = useListingStore();
  const store = useMarksStore();
  const navigate = useNavigate();
  const shoots = useShootsStore();
  const albums = useAlbumsStore();
  const libraries = useLibrariesStore();
  const replicationStore = useReplicationStore();
  const { photos, replication, export: exportPhotos, frameTv } = usePresenters();
  const [creating, setCreating] = useState<'shoot' | 'album' | null>(null);

  // The selection itself, not the ids: it may name more photographs than this client
  // has ever held rows for, and the export resolves it when it runs (§18.3.3). The
  // frame is off whichever selected row is loaded, since the estimate wants a size
  // and one photograph's is as good as another's for that.
  const openExport = (): void => {
    const target = photos.selectionTarget();
    if (target == null) return;
    const frame = store.selectedLoadedPhotos[0] ?? null;
    exportPhotos.openFor(target, store.selectionCount, frame && { width: frame.width, height: frame.height });
  };

  if (!store.hasSelection) return null;

  // Binned photos are excluded from the shoot/album membership queries, so
  // offering those actions here would only ever produce "photos not found".
  // The Bin's one meaningful action is putting them back.
  const inBin = listing.isBin;
  // Positions and members, as one number: a photo picked out of an open band is
  // in the same selection as a tile in the grid, and every action reaches both
  // (§19.6.1). Photographs rather than tiles, since a stack's row is acted on
  // whole - the two differ, so `entries` is what the gestures below are about.
  const count = store.selectionCount;
  const entries = store.selectedEntries;
  const members = store.selectedMembers.size > 0;
  const marks = store.selectedMarks;
  const selectedStack = store.selectedStack;
  const mergeCandidate = store.mergeCandidate;
  // The banner is the selection's first photograph, so there is nothing to offer
  // when the selection reaches only rows this client is not holding.
  const thumbnail =
    collection == null || store.firstSelectedPhotoId == null ? null : bannerLabel(collection.kind, count < 2);
  // "all" rather than a number for the whole collection, for the reason the bar's
  // own count carries none there: the stacks in the rows this client never held
  // stand for a number only the server knows.
  const binLabel =
    count < 2 ? BulkBarStrings.moveToBin()
    : store.allSelected ? BulkBarStrings.moveAllToBin()
    : BulkBarStrings.moveCountToBin(count);
  // Which library this collection belongs to, read off the collection rather
  // than off a row: rows are a sparse, evictable window, so a guard keyed on one
  // lapses when the reader scrolls past the block holding it. An album names no
  // library at all, spanning as many as its members do, so it answers `undefined`
  // and the server is what refuses.
  const source = listing.source;
  const libraryId =
    source == null ? undefined
    : 'libraryId' in source ? source.libraryId
    : source.kind === 'shoot' ? shoots.byId.get(source.shootId)?.library_id
    : undefined;
  const library = libraryId == null ? undefined : libraries.byId.get(libraryId);
  const readOnly = library?.read_only === true;
  const readOnlyRefusal = readOnly ? BulkBarStrings.notOnReadOnlyLibrary() : undefined;
  // An album spans libraries, so it names none and offers no eviction: which
  // peer holds a copy is a question per library, and the selection has no one.
  const peers = libraryId == null ? [] : replicationStore.peersOf(libraryId);
  // Per photograph, not per library: a library flipped to read-only keeps the bin
  // it had, and everything binned *since* the flip is in place and restores
  // without a move. Only the rows this client holds can be tested, so a selection
  // reaching further is left enabled for the server to refuse - blocking an
  // action that would have worked is worse than a clear 403.
  const restoreRefused =
    readOnly && library?.bin_name != null && store.selectedLoadedPaths.some((p) => p.startsWith(`${library.bin_name}/`));
  const removable = collection == null || store.selectionOutsideShoot ? null : collection;
  // Taking a photograph *out* of a shoot moves its file back to the library root,
  // so it is the same write filing one into a shoot is. Leaving an album is rows only.
  const removeRefusal = removable?.kind === 'shoot' ? readOnlyRefusal : undefined;
  // The shoot the selection is already in is not somewhere it can be moved to, so it is not offered as one.
  // A hidden shoot is not somewhere to file a photograph: it would move the file and then take the
  // photograph out of the grid it was chosen in, which reads as a bulk action that lost them.
  const filable = shoots.shoots.filter((shoot) => shoot.id !== store.selectionShootId && !shoot.is_hidden);
  const revealId =
    canRevealFile() && count === 1 && !store.selectedLoadedPhotos.some(isComposite) ? store.firstSelectedPhotoId : null;

  return (
    <div {...stylex.props(styles.bar)} role="group" aria-label={BulkBarStrings.selection()}>
      {/* "all" and no number when it is the whole collection: it is what the
          reader is asking about at six figures anyway, and a count is not
          something the client can answer there - the stacks in the rows it has
          never held stand for a number only the server knows. */}
      <Text variant="mono" style={styles.count}>
        {store.allSelected ? BulkBarStrings.allSelected() : BulkBarStrings.countSelected(count)}
      </Text>
      <Button variant="ghost" onClick={photos.clearSelection}>
        <X size={ICON} />
        {BulkBarStrings.clear()}
      </Button>

      {/* The cull's own two decisions, over the selection, for the same reason
          they are on every tile: routing a burst's verdict through the tiles one
          at a time is what the bar is here to save (§18.3.1). Not in the Bin,
          where a verdict on something already thrown out decides nothing. */}
      {!inBin && <Verdict triage={marks.triage} onSet={(triage) => void photos.markSelection({ triage })} large />}

      {/* Only about the members: taking a photo out of the stack it is in is not
          something the positions in a selection can express. */}
      {!inBin && members && (
        <Button onClick={() => void photos.removeSelectedFromStacks()}>
          <Layers2 size={ICON} />
          {BulkBarStrings.removeFromStack()}
        </Button>
      )}

      {inBin ? (
        <Button
          variant="primary"
          disabled={restoreRefused}
          tooltip={restoreRefused ? BulkBarStrings.restoreRefused() : undefined}
          onClick={() => void photos.restoreSelected()}
        >
          <RotateCcw size={ICON} />
          {BulkBarStrings.restoreToOriginalLocation()}
        </Button>
      ) : (
        <>
          {/* §7.6. Named per peer because that is what the action is: the copy
              here goes only once the one over there answers for itself, so which
              peer is asked is the whole decision. */}
          {peers.length > 0 && (
            <CheckMenu
              closeOnSelect
              disabled={readOnly}
              tooltip={readOnlyRefusal}
              trigger={
                <>
                  <HardDrive size={ICON} />
                  {BulkBarStrings.removeLocalCopy()}
                </>
              }
              options={peers.map((p) => ({ value: p.peer_id, label: BulkBarStrings.keptOn(p.name) }))}
              selected={[]}
              onToggle={(peerId) => {
                const target = photos.selectionTarget();
                if (target == null || libraryId == null) return;
                const name = replicationStore.peerName(libraryId, peerId);
                if (!window.confirm(BulkBarStrings.removeLocalCopyWarning(name, count, store.allSelected))) return;
                void replication.removeLocalCopies(target, libraryId, peerId);
              }}
            />
          )}

          <OverflowMenu
            label={BulkBarStrings.moreActions()}
            sections={[
              menuSection({
                label: PhotoDetailStrings.rating(),
                content: (
                  <Rating
                    rating={marks.rating}
                    onSet={(rating) => void photos.markSelection({ rating })}
                    focusable={false}
                    style={styles.menuRating}
                  />
                ),
              }),
              menuSection({
                options: stackOptions({
                  canStack: entries > 1,
                  canUnstack: store.hasSelectedStack,
                  stack: selectedStack,
                }),
                onSelect: (action) => {
                  if (action === 'stack') void photos.stackSelection();
                  else if (action === 'unstack') void photos.unstackSelection();
                  else if (selectedStack.kind === 'stack') navigate(triagePath(selectedStack.stackId, listing.source));
                },
              }),
              // A section of its own: `OverflowMenu` renders a section's `content` above its
              // `options`, so putting this in the stack section would push it above Stack and
              // Unstack and break the adjacency those two are ordered for.
              menuSection({
                content: (
                  <Submenu
                    label={MergePageStrings.mergePhotos()}
                    icon={<PanoramaIcon size={ICON} />}
                    options={[
                      { value: 'panorama' as const, label: MergePageStrings.toPanorama() },
                      {
                        value: 'assembly' as const,
                        label: MergePageStrings.takeBestParts(),
                        disabled: mergeCandidate.kind !== 'ready',
                        tooltip: mergeRefusal(mergeCandidate),
                      },
                    ]}
                    onSelect={(action: MergeAction) => {
                      if (action === 'panorama') void photos.mergeSelectionToPanorama();
                      else if (mergeCandidate.kind === 'ready') {
                        const source = listing.source;
                        void photos.startAssembly(mergeCandidate.frames.map((frame) => frame.id)).then((jobId) => {
                          if (jobId != null) navigate(mergeJobPath(jobId, source));
                        });
                      }
                    }}
                  />
                ),
              }),
              menuSection({
                content: (
                  <>
                    {libraryId != null && (
                      <Submenu
                        label={store.selectionInAShoot ? BulkBarStrings.moveToShoot() : BulkBarStrings.addToShoot()}
                        icon={<FolderInput size={ICON} />}
                        options={[
                          ...filable.map((shoot) => ({ value: shoot.id, label: shoot.folder_path })),
                          {
                            value: NEW_COLLECTION,
                            label: store.selectionInAShoot ? BulkBarStrings.moveToNewShoot() : BulkBarStrings.addToNewShoot(),
                            icon: <Plus size={ICON} />,
                          },
                        ]}
                        onSelect={(shootId) =>
                          shootId === NEW_COLLECTION ? setCreating('shoot') : void photos.addSelectedToShoot(shootId)
                        }
                        disabled={readOnly}
                        tooltip={readOnlyRefusal}
                      />
                    )}
                    <Submenu
                      label={BulkBarStrings.addToAlbum()}
                      icon={<Images size={ICON} />}
                      options={[
                        ...albums.albums.map((album) => ({ value: album.id, label: album.name })),
                        { value: NEW_COLLECTION, label: BulkBarStrings.addToNewAlbum(), icon: <Plus size={ICON} /> },
                      ]}
                      onSelect={(albumId) =>
                        albumId === NEW_COLLECTION ? setCreating('album') : void photos.addSelectedToAlbum(albumId)
                      }
                    />
                  </>
                ),
                options: filingOptions({
                  removeFrom: removable == null ? null : BulkBarStrings.removeFrom(removable.name),
                  removeRefusal,
                  banner: thumbnail,
                }),
                onSelect: (action) => {
                  if (action === 'banner') {
                    if (collection != null) void photos.setSelectionAsBanner(collection);
                  } else if (removable != null) {
                    void (removable.kind === 'shoot'
                      ? photos.removeSelectedFromShoot(removable.id)
                      : photos.removeSelectedFromAlbum(removable.id));
                  }
                },
              }),
              menuSection({
                content: <SendToFrameTv onSend={(tvId) => void frameTv.sendSelection(tvId)} />,
                options: photoOptions(binLabel, revealId != null),
                onSelect: (action) => {
                  if (action === 'export') openExport();
                  else if (action === 'reveal') void (revealId != null && photos.revealOriginal(revealId));
                  else if (action === 'thumbnails') void photos.rebuildGridRenditions();
                  else if (action === 'metadata') void photos.refreshMetadataForSelection();
                  else if (action === 'hide') void photos.hideSelected(true);
                  else if (action === 'unhide') void photos.hideSelected(false);
                  else void photos.deleteSelected();
                },
              }),
            ]}
          />

          {libraryId != null && (
            <AddShootDialog
              libraryId={libraryId}
              parentPath=""
              open={creating === 'shoot'}
              onOpenChange={(open) => !open && setCreating(null)}
              onCreated={(shootId) => void photos.addSelectedToShoot(shootId)}
            />
          )}
          <AddAlbumDialog
            open={creating === 'album'}
            onOpenChange={(open) => !open && setCreating(null)}
            onCreated={(albumId) => void photos.addSelectedToAlbum(albumId)}
          />
        </>
      )}
    </div>
  );
});
