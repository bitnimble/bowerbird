import { observer } from 'mobx-react-lite';
import { Ellipsis, FolderInput, Images, Layers, Layers2, RotateCcw, RotateCw, Sparkles, Trash2, X } from 'lucide-react';
import { useAlbumsStore, usePhotosStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { ActionMenu, Button, CheckMenu, ICON, type Option, Text } from '../../ui/ui';

// What can be done to photos picked out inside an open stack. Only the two
// actions that are about the stack: everything else here works on positions,
// which is what a member does not have.
const MemberBar = observer(function MemberBar(): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  return (
    <div className="bulkbar">
      <Text variant="mono" className="bulkbar__count">
        {store.selectedMembers.size} selected in {store.selectedMembers.size === 1 ? 'a stack' : 'stacks'}
      </Text>
      <Button variant="ghost" onClick={photos.clearMemberSelection}>
        <X size={ICON} />
        Clear
      </Button>
      <div className="spacer" />
      <Button onClick={() => void photos.removeSelectedFromStacks()}>
        <Layers2 size={ICON} />
        Remove from stack
      </Button>
    </div>
  );
});

// Behind the overflow, so the bar's own row holds only what is about *this*
// selection - where it goes and what it becomes. These three are maintenance:
// reached deliberately, and two of them rarely.
type Overflow = 'thumbnails' | 'metadata' | 'bin';

const OVERFLOW: Option<Overflow>[] = [
  { value: 'thumbnails', label: 'Rebuild thumbnails', icon: <Sparkles size={ICON} /> },
  { value: 'metadata', label: 'Refresh metadata', icon: <RotateCw size={ICON} /> },
  { value: 'bin', label: 'Move to Bin', icon: <Trash2 size={ICON} />, destructive: true },
];

interface Props {
  // Set on a shoot or album page so the selection can be removed from it, not
  // just added to another one.
  removeFrom?: { kind: 'shoot' | 'album'; id: string; name: string };
}

// Bulk actions for the current selection. Part of the header and always mounted,
// with its actions disabled until there is something to act on: rendered only when
// a selection existed, it appeared and disappeared under the reader, and since a
// click selects that meant the tiles moving by a bar's height mid-gesture - between
// the two clicks of a double-click (§18.3.1).
export const BulkBar = observer(function BulkBar({ removeFrom }: Props): JSX.Element {
  const store = usePhotosStore();
  const shoots = useShootsStore();
  const albums = useAlbumsStore();
  const { photos } = usePresenters();

  // Members of an open stack are a selection of their own, held by id because a
  // collapsed listing gives them no position (§19.6). The two are different
  // intentions - "everything in this library" against "these frames of this
  // burst" - so the bar acts on whichever one is live.
  if (store.selectedMembers.size > 0) return <MemberBar />;

  // Binned photos are excluded from the shoot/album membership queries, so
  // offering those actions here would only ever produce "photos not found".
  // The Bin's one meaningful action is putting them back.
  const inBin = store.isBin;
  const count = store.selectionCount;
  const none = count === 0;

  return (
    <div className="bulkbar">
      {/* Only once the selection is more than the one photo the cursor is on:
          below that the ring says everything the count would, and a bar that
          reads "1 selected" beside it is noise.
          "all" rather than the bare count when it is the whole collection: at
          six figures the number alone does not tell you whether you got it.
          Entries rather than photographs, because a stack is one entry standing
          for however many it holds, and the client cannot know the sizes of the
          stacks in a selection covering rows it has never held. */}
      {count > 1 && (
        <>
          <Text variant="mono" className="bulkbar__count">
            {store.allSelected ? `all ${count} selected` : `${count} selected`}
          </Text>
          <Button variant="ghost" onClick={photos.clearSelection}>
            <X size={ICON} />
            Clear
          </Button>
        </>
      )}

      <div className="spacer" />

      {/* Conditional rather than disabled, unlike the rest of the bar: these two
          are not "this action, once you have a selection" but statements about
          what the selection *is* - two photos to fuse, or one stack to break -
          and greyed out they read as actions the reader has failed to reach. */}
      {!inBin && count > 1 && (
        <Button onClick={() => void photos.stackSelection()}>
          <Layers size={ICON} />
          Stack
        </Button>
      )}

      {!inBin && store.selectedStackId != null && (
        <Button onClick={() => void photos.unstack(store.selectedStackId!)}>
          <Layers2 size={ICON} />
          Unstack
        </Button>
      )}

      {inBin ? (
        <Button variant="primary" disabled={none} onClick={() => void photos.restoreSelected()}>
          <RotateCcw size={ICON} />
          Restore to original location
        </Button>
      ) : (
        <>
          {shoots.shoots.length > 0 && (
            <CheckMenu
              disabled={none}
              // One action, not a set of boxes to tick, so the menu closes behind
              // it. Load-bearing now the bar is always mounted: nothing else takes
              // the popup away, and its backdrop swallowed every click after.
              closeOnSelect
              trigger={
                <>
                  <FolderInput size={ICON} />
                  Add to shoot
                </>
              }
              options={shoots.shoots.map((s) => ({ value: s.id, label: s.folder_path }))}
              selected={[]}
              onToggle={(shootId) => void photos.addSelectedToShoot(shootId)}
            />
          )}

          {albums.albums.length > 0 && (
            <CheckMenu
              disabled={none}
              closeOnSelect
              trigger={
                <>
                  <Images size={ICON} />
                  Add to album
                </>
              }
              options={albums.albums.map((a) => ({ value: a.id, label: a.name }))}
              selected={[]}
              onToggle={(albumId) => void photos.addSelectedToAlbum(albumId)}
            />
          )}

          {removeFrom != null && (
            <Button
              disabled={none}
              onClick={() =>
                void (removeFrom.kind === 'shoot'
                  ? photos.removeSelectedFromShoot(removeFrom.id)
                  : photos.removeSelectedFromAlbum(removeFrom.id))
              }
            >
              <X size={ICON} />
              Remove from {removeFrom.name}
            </Button>
          )}

          <ActionMenu
            label="More actions"
            disabled={none}
            trigger={<Ellipsis size={ICON} />}
            options={OVERFLOW}
            onSelect={(action) => {
              if (action === 'thumbnails') void photos.rebuildGridRenditions();
              else if (action === 'metadata') void photos.refreshMetadataForSelection();
              else void photos.deleteSelected();
            }}
          />
        </>
      )}
    </div>
  );
});
