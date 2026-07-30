import { observer } from 'mobx-react-lite';
import { Ellipsis, FolderInput, Images, Layers, Layers2, RotateCcw, RotateCw, Sparkles, Trash2, X } from 'lucide-react';
import { useAlbumsStore, usePhotosStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { ActionMenu, Button, CheckMenu, ICON, type Option, Text } from '../../ui/ui';

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

  // Binned photos are excluded from the shoot/album membership queries, so
  // offering those actions here would only ever produce "photos not found".
  // The Bin's one meaningful action is putting them back.
  const inBin = store.isBin;
  // Positions and members, as one number: a photo picked out of an open band is
  // in the same selection as a tile in the grid, and every action reaches both
  // (§19.6.1). Photographs rather than tiles, since a stack's row is acted on
  // whole - the two differ, so `entries` is what the gestures below are about.
  const count = store.selectionCount;
  const entries = store.selectedEntries;
  const none = count === 0;
  const members = store.selectedMembers.size > 0;

  return (
    <div className="bulkbar">
      {/* Only once the selection is more than the one photo the cursor is on:
          below that the ring says everything the count would, and a bar that
          reads "1 selected" beside it is noise.
          "all" and no number when it is the whole collection: it is what the
          reader is asking about at six figures anyway, and a count is not
          something the client can answer there - the stacks in the rows it has
          never held stand for a number only the server knows. */}
      {count > 1 && (
        <>
          <Text variant="mono" className="bulkbar__count">
            {store.allSelected ? 'all selected' : `${count} selected`}
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
      {!inBin && entries > 1 && (
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

      {/* Only about the members: taking a photo out of the stack it is in is not
          something the positions in a selection can express. */}
      {!inBin && members && (
        <Button onClick={() => void photos.removeSelectedFromStacks()}>
          <Layers2 size={ICON} />
          Remove from stack
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
