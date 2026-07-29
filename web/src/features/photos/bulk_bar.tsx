import { observer } from 'mobx-react-lite';
import { FolderInput, Images, RotateCcw, RotateCw, Sparkles, Trash2, X } from 'lucide-react';
import { useAlbumsStore, usePhotosStore, usePresenters, useShootsStore } from '../../app/stores_context';
import { Button, CheckMenu, ICON, Text } from '../../ui/ui';

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

  if (!store.hasSelection) return null;

  // Binned photos are excluded from the shoot/album membership queries, so
  // offering those actions here would only ever produce "photos not found".
  // The Bin's one meaningful action is putting them back.
  const inBin = store.isBin;

  return (
    <div className="bulkbar">
      <Text variant="mono" className="bulkbar__count">
        {store.selectionCount} selected
      </Text>
      <Button variant="ghost" onClick={photos.clearSelection}>
        <X size={ICON} />
        Clear
      </Button>

      <div className="spacer" />

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
