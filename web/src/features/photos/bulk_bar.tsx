import { observer } from 'mobx-react-lite';
import { FolderInput, Images, Layers, Layers2, RotateCcw, RotateCw, Sparkles, Trash2, X } from 'lucide-react';
import { useAlbumsStore, usePhotosStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { Button, CheckMenu, ICON, Text } from '../../ui/ui';

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

interface Props {
  // Set on a shoot or album page so the selection can be removed from it, not
  // just added to another one.
  removeFrom?: { kind: 'shoot' | 'album'; id: string; name: string };
}

// Bulk actions for the current selection. Rendered only when something is
// selected, so it never takes space it hasn't earned.
export const BulkBar = observer(function BulkBar({ removeFrom }: Props): JSX.Element | null {
  const store = usePhotosStore();
  const shoots = useShootsStore();
  const albums = useAlbumsStore();
  const { photos } = usePresenters();

  // Members of an open stack are a selection of their own, held by id because a
  // collapsed listing gives them no position (§19.6). The two are different
  // intentions - "everything in this library" against "these frames of this
  // burst" - so the bar acts on whichever one is live.
  if (store.selectedMembers.size > 0) return <MemberBar />;

  if (!store.hasSelection) return null;

  // Binned photos are excluded from the shoot/album membership queries, so
  // offering those actions here would only ever produce "photos not found".
  // The Bin's one meaningful action is putting them back.
  const inBin = store.isBin;

  return (
    <div className="bulkbar">
      {/* "all" rather than the bare count when it is the whole collection: at
          six figures the number alone does not tell you whether you got it.
          Entries rather than photographs, because a stack is one entry standing
          for however many it holds, and the client cannot know the sizes of the
          stacks in a selection covering rows it has never held. */}
      <Text variant="mono" className="bulkbar__count">
        {store.allSelected ? `all ${store.selectionCount} selected` : `${store.selectionCount} selected`}
      </Text>
      <Button variant="ghost" onClick={photos.clearSelection}>
        <X size={ICON} />
        Clear
      </Button>

      <div className="spacer" />

      {!inBin && store.selectionCount >= 2 && (
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
        <Button variant="primary" onClick={() => void photos.restoreSelected()}>
          <RotateCcw size={ICON} />
          Restore to original location
        </Button>
      ) : (
        <>
          {shoots.shoots.length > 0 && (
            <CheckMenu
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

          <Button onClick={() => void photos.rebuildGridRenditions()}>
            <Sparkles size={ICON} />
            Rebuild grid renditions
          </Button>

          <Button onClick={() => void photos.refreshMetadataForSelection()}>
            <RotateCw size={ICON} />
            Refresh metadata
          </Button>

          {removeFrom != null && (
            <Button
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

          <Button variant="danger" onClick={() => void photos.deleteSelected()}>
            <Trash2 size={ICON} />
            Move to Bin
          </Button>
        </>
      )}
    </div>
  );
});
