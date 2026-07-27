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
  RefreshCw,
  RotateCw,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  jpegUrl,
  losslessUrl,
  losslessVideoUrl,
  needsHdrVideo,
  originalUrl,
  previewUrl,
  previewVideoUrl,
  thumbnailUrl,
  type PreviewRendition,
} from '../../api/client';
import { localDateTime } from '../../api/dates';
import { useAlbumsStore, usePhotosStore, usePresenters, useServerConfigStore, useShootsStore } from '../../app/stores_context';
import { ActionMenu, type ActionGroup, Button, ICON, MoreLess, type Option, Text, TextArea } from '../../ui/ui';
import { renditionLabel } from './photos_presenter';
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

type PhotoAction = PreviewRendition | 'metadata';

const RENDITIONS: Option<PhotoAction>[] = [
  { value: 'embedded', label: 'Embedded JPEG', icon: <Sparkles size={ICON} /> },
  { value: 'render', label: 'From RAW', icon: <Wand2 size={ICON} /> },
  { value: 'max', label: 'From RAW (max quality)', icon: <Maximize2 size={ICON} /> },
];

// Renditions of the same frame rather than commands: each is built once and
// cached, so these read as "which one am I looking at", not "rebuild it now".
// The camera's JPEG is dropped once a render is on screen: it is the only step
// down the quality ladder, and nobody goes back to it having seen the RAW.
function actions(showing: PreviewRendition): (Option<PhotoAction> | ActionGroup<PhotoAction>)[] {
  return [
    { value: 'metadata', label: 'Refresh metadata', icon: <RotateCw size={ICON} /> },
    {
      label: 'Image preview',
      icon: <ImageIcon size={ICON} />,
      options: showing === 'embedded' ? RENDITIONS : RENDITIONS.filter((option) => option.value !== 'embedded'),
    },
  ];
}

export const PhotoDetailPage = observer(function PhotoDetailPage(): JSX.Element {
  const { photoId = '' } = useParams();
  const store = usePhotosStore();
  const shoots = useShootsStore();
  const albums = useAlbumsStore();
  const serverConfig = useServerConfigStore();
  const { photos, serverConfig: configPresenter, appSettings } = usePresenters();
  const navigate = useNavigate();
  const [notes, setNotes] = useState('');
  // Actual pixels of the served thumbnail, so the panel reports what is on
  // screen rather than the RAW's dimensions.
  const [thumbSize, setThumbSize] = useState<{ width: number; height: number } | null>(null);

  useEffect(() => {
    // Settings first: they decide which rendition this photo opens at, and it
    // is fetched once per session, so only the first photo pays for it.
    void appSettings.load().then(() => photos.openDetail(photoId));
    void configPresenter.load();
    // Cleared on the route change rather than when the detail arrives: the panel
    // must stop claiming the previous photo's resolution the moment we navigate,
    // and the new image can take a while to decode.
    setThumbSize(null);
  }, [photoId, photos, configPresenter, appSettings]);

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

  // Null is the photo's own thumbnail, which is already one of the three: the
  // rendition its library builds on import. Naming it keeps the menu and the
  // panel honest about what is on screen without a fourth state to reason about.
  const rendition = store.rendition;
  const showing: PreviewRendition = rendition ?? photo?.thumbnail_source ?? 'embedded';
  const maxQuality = rendition === 'max';
  const stillSrc =
    rendition === 'max'
      ? losslessUrl(photoId)
      : rendition == null
        ? thumbnailUrl(photoId, 'full', store.rebuiltAt)
        : previewUrl(photoId, rendition, store.rebuiltAt);

  // Firefox renders an HDR still dark - it applies a PQ transfer to nothing but
  // video - so it gets the one-frame video of whichever rendition is showing
  // instead (§10.7). Every rendition is the same picture at a different quality,
  // so each has a twin where HDR applies; the embedded one never does, being an
  // 8-bit SDR JPEG, so its still is already right.
  const showingRender = rendition === 'render' || (rendition == null && photo?.thumbnail_hdr === true);
  const hdrVideo = needsHdrVideo() && (maxQuality ? photo?.has_lossless_video === true : photo?.preview_hdr_video === true && showingRender);

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
          options={actions(showing)}
          onSelect={(action) => {
            if (action === 'metadata') void photos.refreshMetadata([photoId]);
            else void photos.chooseRendition(photoId, action);
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
        {store.buildingRendition && <Text variant="mono">building…</Text>}
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
          src={hdrVideo ? (maxQuality ? losslessVideoUrl(photoId) : previewVideoUrl(photoId, store.rebuiltAt)) : stillSrc}
          video={hdrVideo}
          alt={filename}
          filename={filename}
          onImageLoad={(width, height) => setThumbSize({ width, height })}
          // Only the photo's own preview is built on sight. A chosen rendition was
          // built before it was shown, so a 404 there is a real fault, not a gap.
          onImageMissing={rendition != null ? undefined : () => void photos.buildMissingPreview(photoId)}
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
                  ['Source', rendition == null && photo.thumbnail_source == null ? 'unknown' : renditionLabel(showing)],
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
