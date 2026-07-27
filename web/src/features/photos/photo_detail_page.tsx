import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
  FileImage,
  FileType,
  Image as ImageIcon,
  Maximize2,
  Minimize2,
  RefreshCw,
  RotateCw,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { jpegUrl, originalUrl, previewUrl, thumbnailUrl, type ThumbnailSource } from '../../api/client';
import { localDateTime } from '../../api/dates';
import { useAlbumsStore, usePhotosStore, usePresenters, useServerConfigStore, useShootsStore } from '../../app/stores_context';
import { ActionMenu, type ActionGroup, Button, ICON, MoreLess, type Option, Text, TextArea } from '../../ui/ui';
import { sourceLabel } from './photos_presenter';
import { PhotoStage } from './photo_stage';
import { TRIAGE_KEYS, TriageControl } from './triage_control';

type Row = [label: string, value: React.ReactNode];

// Two rows visible, the rest one click away. Every panel then costs the same
// three lines, so the column stays scannable however much a camera recorded.
const VISIBLE_ROWS = 2;

function MetaPanel({ title, rows }: { title: string; rows: Row[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, VISIBLE_ROWS);
  const hidden = rows.length - VISIBLE_ROWS;

  return (
    <div className="panel">
      <Text variant="label" as="div" className="panel__title">
        {title}
      </Text>
      <dl className="meta">
        {shown.map(([name, value]) => (
          <Fragment key={name}>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      {hidden > 0 && <MoreLess count={hidden} open={open} onToggle={() => setOpen((v) => !v)} />}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="panel">
      <Text variant="label" as="div" className="panel__title">
        {title}
      </Text>
      {children}
    </div>
  );
}

// 1/250 reads as a shutter speed; 0.004 does not.
function shutterLabel(seconds: number): string {
  return seconds >= 1 ? `${seconds.toFixed(1)}s` : `1/${Math.round(1 / seconds)}s`;
}

// "Sony ILCE-7CR", but not "Sony Sony A7": models often already carry the brand.
function bodyLabel(make: string | null, model: string | null): string {
  if (model == null) return make ?? 'not recorded';
  if (make == null || model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return `${make} ${model}`;
}

function fileSizeLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const DOWNLOADS: Option<'raw' | 'jpeg'>[] = [
  { value: 'raw', label: 'Original RAW', icon: <FileType size={ICON} /> },
  { value: 'jpeg', label: 'JPEG', icon: <FileImage size={ICON} /> },
];

type PhotoAction = ThumbnailSource | 'metadata' | 'lossless';

// Renditions of the same frame rather than commands: each is built once and
// cached, so these read as "which one am I looking at", not "rebuild it now".
const ACTIONS: (Option<PhotoAction> | ActionGroup<PhotoAction>)[] = [
  { value: 'metadata', label: 'Refresh metadata', icon: <RotateCw size={ICON} /> },
  {
    label: 'Image preview',
    icon: <ImageIcon size={ICON} />,
    options: [
      { value: 'embedded', label: 'Embedded JPEG', icon: <Sparkles size={ICON} /> },
      { value: 'render', label: 'From RAW', icon: <Wand2 size={ICON} /> },
      { value: 'lossless', label: 'From RAW (max quality)', icon: <Maximize2 size={ICON} /> },
    ],
  },
];

export const PhotoDetailPage = observer(function PhotoDetailPage(): JSX.Element {
  const { photoId = '' } = useParams();
  const store = usePhotosStore();
  const shoots = useShootsStore();
  const albums = useAlbumsStore();
  const serverConfig = useServerConfigStore();
  const { photos, serverConfig: configPresenter } = usePresenters();
  const navigate = useNavigate();
  const [notes, setNotes] = useState('');
  // Actual pixels of the served thumbnail, so the panel reports what is on
  // screen rather than the RAW's dimensions.
  const [thumbSize, setThumbSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    void photos.openDetail(photoId);
    void configPresenter.load();
    // Cleared on the route change rather than when the detail arrives: the panel
    // must stop claiming the previous photo's resolution the moment we navigate,
    // and the new image can take a while to decode.
    setThumbSize(null);
  }, [photoId, photos, configPresenter]);

  // The store deliberately keeps the previous detail while the next loads, so
  // the rail doesn't collapse on every next/prev. Everything driven by *this*
  // photo's data has to check the id, or it renders the one before it.
  const photo = store.detail?.id === photoId ? store.detail : null;
  // Keyed on the id alone. Also watching photo.notes would let a save that lands
  // after the user has started typing again overwrite the field mid-edit.
  useEffect(() => {
    setNotes(photo?.notes ?? '');
  }, [photo?.id]);

  const prevId = store.prevPhotoId;
  const nextId = store.nextPhotoId;
  const libraryId = store.detailLibraryId;

  // The render is built once and cached server-side; a second visit only pays
  // for the download and the wasm decode.
  async function showOriginal(): Promise<void> {
    await photos.showLossless(photoId);
  }

  // Stepping through frames and judging them is the whole point of a detail view
  // during a cull, so the verdict keys work here exactly as they do in the grid.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const verdict = TRIAGE_KEYS[e.key];
      if (verdict != null) void photos.setTriage(photoId, verdict);
      else if (/^[0-5]$/.test(e.key)) void photos.setRating(photoId, Number(e.key));
      else if (e.key === 'ArrowLeft' && prevId != null) navigate(`/photos/${prevId}`);
      else if (e.key === 'ArrowRight' && nextId != null) navigate(`/photos/${nextId}`);
      else if (e.key === 'Escape' && document.fullscreenElement == null && libraryId != null) navigate(`/libraries/${libraryId}`);
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prevId, nextId, navigate, libraryId, photoId, photos]);

  if (photo == null && !store.detailLoading) {
    return (
      <div className="pad">
        <div className="empty">
          <div className="empty__title">Photo not found</div>
          <Text as="p" variant="muted">
            {store.error ?? 'It may have been removed from the catalogue.'}
          </Text>
        </div>
      </div>
    );
  }

  const shoot = photo?.shoot_id == null ? null : shoots.byId.get(photo.shoot_id);
  const photoAlbums = photo == null ? [] : albums.albums.filter((a) => photo.album_ids.includes(a.id));
  const notesDirty = notes !== (photo?.notes ?? '');
  const thumbs = serverConfig.config?.thumbnails;

  // A wide photo wastes horizontal space if the panel sits beside it, and a tall
  // one wastes vertical space if the panel sits under it. Put the panel on
  // whichever edge leaves the photo biggest.
  const landscape = photo == null || photo.width >= photo.height;
  const filename = photo?.file_path.split('/').pop() ?? photoId;

  return (
    <div className="pad detail-page">
      <div className="row detail__nav">
        <Button render={<Link to={libraryId == null ? '/' : `/libraries/${libraryId}`} />}>
          <ArrowLeft size={ICON} />
          Library
        </Button>
        <Button iconOnly aria-label="Previous photo" disabled={prevId == null} onClick={() => prevId != null && navigate(`/photos/${prevId}`)}>
          <ChevronLeft size={ICON} />
        </Button>
        <Button iconOnly aria-label="Next photo" disabled={nextId == null} onClick={() => nextId != null && navigate(`/photos/${nextId}`)}>
          <ChevronRight size={ICON} />
        </Button>
        <Text variant="mono">{photo?.file_path ?? ''}</Text>

        <div className="spacer" />

        <ActionMenu
          trigger={
            <>
              <RefreshCw size={ICON} />
              Actions
            </>
          }
          options={ACTIONS}
          onSelect={(action) => {
            if (action === 'metadata') void photos.refreshMetadata([photoId]);
            else if (action === 'lossless') void showOriginal();
            else void photos.showPreview(photoId, action);
          }}
        />
        <ActionMenu
          trigger={
            <>
              <Download size={ICON} />
              Download
            </>
          }
          options={DOWNLOADS}
          onSelect={(kind) => {
            window.location.href = kind === 'raw' ? originalUrl(photoId) : jpegUrl(photoId);
          }}
        />
        {(store.buildingLossless || store.buildingPreview) && <Text variant="mono">building…</Text>}
        {(store.lossless != null || store.previewSource != null) && (
          <Button onClick={store.lossless != null ? photos.hideLossless : photos.resetPreview}>
            <Minimize2 size={ICON} />
            Back to preview
          </Button>
        )}
        {photo != null && !photo.is_deleted && (
          <Button variant="danger" onClick={() => void photos.deletePhotos([photo.id])}>
            <Trash2 size={ICON} />
            Move to Bin
          </Button>
        )}
      </div>

      <div className={landscape ? 'detail detail--below' : 'detail detail--beside'}>
        {/* Keyed off the route, not the loaded detail, so the photo on screen is
            always the one the URL asks for. */}
        <PhotoStage
          src={
            store.lossless?.url ??
            (store.previewSource == null
              ? thumbnailUrl(photoId, 'full', store.rebuiltAt)
              : previewUrl(photoId, store.previewSource, store.rebuiltAt))
          }
          alt={filename}
          filename={filename}
          onImageLoad={(width, height) => setThumbSize({ width, height })}
          // Only the photo's own preview is built on sight. A chosen rendition was
          // built before it was shown, so a 404 there is a real fault, not a gap.
          onImageMissing={store.previewSource != null ? undefined : () => void photos.buildMissingPreview(photoId)}
        />

        <div className="detail__panels">
          {photo != null && (
            <>
              <Panel title="Triage">
                <TriageControl value={photo.triage} onChange={(next) => void photos.setTriage(photo.id, next)} />

                <div className="row detail__rating">
                  <Text variant="label">Rating</Text>
                  <div className="stars">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={`star${n <= photo.rating ? ' on' : ''}`}
                        aria-label={`Set rating to ${n}`}
                        onClick={() => void photos.setRating(photo.id, n === photo.rating ? 0 : n)}
                      >
                        ★
                      </button>
                    ))}
                  </div>
                </div>
              </Panel>

              <Panel title="Notes">
                <TextArea
                  label="Notes"
                  placeholder="Add a note"
                  value={notes}
                  onChange={setNotes}
                  onBlur={() => {
                    if (notesDirty) void photos.setNotes(photo.id, notes);
                  }}
                />
                <Text variant="mono">{notesDirty ? 'unsaved' : store.notesSavedAt != null ? 'saved' : ''}</Text>
              </Panel>

              <MetaPanel
                title="Camera"
                rows={[
                  ['Body', bodyLabel(photo.camera_make, photo.camera_model)],
                  ['Lens', photo.lens_model ?? 'not recorded'],
                  ['ISO', photo.iso ?? 'not recorded'],
                  ['Shutter', photo.shutter_speed == null ? 'not recorded' : shutterLabel(photo.shutter_speed)],
                  ['Aperture', photo.aperture == null ? 'not recorded' : `f/${photo.aperture.toFixed(1)}`],
                  ['Focal length', photo.focal_length == null ? 'not recorded' : `${Math.round(photo.focal_length)}mm`],
                  ['Taken', localDateTime(photo.date_taken) ?? 'not recorded'],
                  [
                    'GPS',
                    photo.latitude == null || photo.longitude == null
                      ? 'not recorded'
                      : `${photo.latitude.toFixed(5)}, ${photo.longitude.toFixed(5)}`,
                  ],
                ]}
              />

              <MetaPanel
                title="Image preview details"
                rows={[
                  // Reports the rendition actually on screen, which is the chosen
                  // one when the user has switched away from the photo's own.
                  // Null on rows thumbnailed before the column existed, which is
                  // "not recorded" rather than "not built".
                  [
                    'Source',
                    store.lossless != null
                      ? 'RAW render (max quality)'
                      : store.previewSource != null
                        ? sourceLabel(store.previewSource)
                        : photo.thumbnail_source == null
                          ? 'unknown'
                          : sourceLabel(photo.thumbnail_source),
                  ],
                  ['Resolution', thumbSize == null ? 'loading' : `${thumbSize.width} × ${thumbSize.height}`],
                  ['Format', thumbs?.format.toUpperCase() ?? 'WEBP'],
                  ['Colour space', thumbs?.color_space ?? 'sRGB'],
                  ['Quality', thumbs == null ? 'unknown' : `${thumbs.full.quality} (longest edge ${thumbs.full.size}px)`],
                ]}
              />

              <MetaPanel
                title="Original RAW"
                rows={[
                  ['File size', photo.file_size == null ? 'unknown' : fileSizeLabel(photo.file_size)],
                  ['Dimensions', `${photo.width} × ${photo.height}`],
                  ['Added', localDateTime(photo.date_added) ?? photo.date_added],
                  ['Shoot', shoot == null ? 'none' : <Link to={`/shoots/${shoot.id}`}>{shoot.folder_path}</Link>],
                  [
                    'Albums',
                    photoAlbums.length === 0
                      ? 'none'
                      : photoAlbums.map((a, i) => (
                          <Fragment key={a.id}>
                            {i > 0 && ', '}
                            <Link to={`/albums/${a.id}`}>{a.name}</Link>
                          </Fragment>
                        )),
                  ],
                  [
                    'State',
                    `${photo.is_missing ? 'missing' : photo.is_deleted ? 'binned' : 'ok'}${photo.needs_processing ? ' · thumbnailing' : ''}`,
                  ],
                  ...(photo.processing_error != null ? ([['Error', photo.processing_error]] as Row[]) : []),
                ]}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
});
