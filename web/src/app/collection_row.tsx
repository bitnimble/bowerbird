import { useState } from 'react';
import { Images, Pencil, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { renditionUrl } from '../api/client';
import { Button } from '../ui/button';
import { ICON } from '../ui/icon';
import { Text } from '../ui/text';
import { TextField } from '../ui/text_field';

interface Props {
  name: string;
  subtitle: string;
  photoCount: number;
  bannerPhotoId: string | null;
  viewHref: string;
  indent?: number;
  onRename: (name: string) => void;
  onDelete: () => void;
  deleteWarning: string;
}

// Shared row for shoots and albums: same affordances, same shape, so the two
// lists stay learnable as one thing.
export function CollectionRow({
  name,
  subtitle,
  photoCount,
  bannerPhotoId,
  viewHref,
  indent = 0,
  onRename,
  onDelete,
  deleteWarning,
}: Props): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  // A shoot shows its first photo from the moment it has one, which is before
  // the import has built that photo's tile, so the banner is routinely asked for
  // a file that is not there yet. Held per photo id rather than as a flag, so a
  // different banner is tried rather than tarred by the last one's failure.
  const [missingBanner, setMissingBanner] = useState<string | null>(null);
  const banner = bannerPhotoId == null || bannerPhotoId === missingBanner ? null : bannerPhotoId;

  function commit(): void {
    const next = draft.trim();
    setEditing(false);
    if (next !== '' && next !== name) onRename(next);
  }

  return (
    <div className="list__row">
      <span className="depth" style={{ width: indent * 16 }} />

      <span className="list__banner" aria-hidden="true">
        {banner == null ? (
          <span className="list__banner--none" />
        ) : (
          <img src={renditionUrl(banner, 'grid')} alt="" onError={() => setMissingBanner(banner)} />
        )}
      </span>

      <div className="list__body">
        {editing ? (
          <TextField
            grow
            autoFocus
            label={`Rename ${name}`}
            value={draft}
            onChange={setDraft}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <span className="list__name">{name}</span>
        )}
        <Text variant="mono" as="div">
          {subtitle} · {photoCount} {photoCount === 1 ? 'photo' : 'photos'}
        </Text>
      </div>

      <Button render={<Link to={viewHref} />}>
        <Images size={ICON} />
        View photos
      </Button>
      {!editing && (
        <Button
          onClick={() => {
            setDraft(name);
            setEditing(true);
          }}
        >
          <Pencil size={ICON} />
          Rename
        </Button>
      )}
      <Button
        variant="danger"
        onClick={() => {
          // Native confirm: this delete cannot be undone, and the platform
          // dialog is modal, accessible and keyboard-safe for free.
          if (window.confirm(deleteWarning)) onDelete();
        }}
      >
        <Trash2 size={ICON} />
        Delete
      </Button>
    </div>
  );
}
