import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Trash2 } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { originalUrl, thumbnailUrl } from '../../api/client';
import { useAlbumsStore, usePhotosStore, usePresenters, useServerConfigStore, useShootsStore } from '../../app/stores_context';
import { Button, ICON, Text, TextArea } from '../../ui/ui';
import { PhotoStage } from './photo_stage';
import { TriageControl } from './triage_control';

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
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

  // Stepping through frames is the whole point of a detail view during a cull.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.key === 'ArrowLeft' && prevId != null) navigate(`/photos/${prevId}`);
      else if (e.key === 'ArrowRight' && nextId != null) navigate(`/photos/${nextId}`);
      else if (e.key === 'Escape' && document.fullscreenElement == null && libraryId != null) navigate(`/libraries/${libraryId}`);
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prevId, nextId, navigate, libraryId]);

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
      </div>

      <div className={landscape ? 'detail detail--below' : 'detail detail--beside'}>
        {/* Keyed off the route, not the loaded detail, so the photo on screen is
            always the one the URL asks for. */}
        <PhotoStage
          src={thumbnailUrl(photoId, 'full')}
          alt={filename}
          filename={filename}
          onImageLoad={(width, height) => setThumbSize({ width, height })}
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

              <Panel title="Camera">
                <dl className="meta">
                  <Field label="Body">{bodyLabel(photo.camera_make, photo.camera_model)}</Field>
                  <Field label="Lens">{photo.lens_model ?? 'not recorded'}</Field>
                  <Field label="ISO">{photo.iso ?? 'not recorded'}</Field>
                  <Field label="Shutter">{photo.shutter_speed == null ? 'not recorded' : shutterLabel(photo.shutter_speed)}</Field>
                  <Field label="Aperture">{photo.aperture == null ? 'not recorded' : `f/${photo.aperture.toFixed(1)}`}</Field>
                  <Field label="Focal length">
                    {photo.focal_length == null ? 'not recorded' : `${Math.round(photo.focal_length)}mm`}
                  </Field>
                  <Field label="Taken">{photo.date_taken ?? 'not recorded'}</Field>
                  <Field label="GPS">
                    {photo.latitude == null || photo.longitude == null
                      ? 'not recorded'
                      : `${photo.latitude.toFixed(5)}, ${photo.longitude.toFixed(5)}`}
                  </Field>
                </dl>
              </Panel>

              <Panel title="Thumbnail on screen">
                <dl className="meta">
                  <Field label="Format">{thumbs?.format.toUpperCase() ?? 'WEBP'}</Field>
                  <Field label="Resolution">{thumbSize == null ? 'loading' : `${thumbSize.width} × ${thumbSize.height}`}</Field>
                  <Field label="Colour space">{thumbs?.color_space ?? 'sRGB'}</Field>
                  <Field label="Quality">
                    {thumbs == null ? 'unknown' : `${thumbs.full.quality} (longest edge ${thumbs.full.size}px)`}
                  </Field>
                </dl>
              </Panel>

              <Panel title="Original RAW">
                <dl className="meta">
                  <Field label="File size">{photo.file_size == null ? 'unknown' : fileSizeLabel(photo.file_size)}</Field>
                  <Field label="Dimensions">
                    {photo.width} × {photo.height}
                  </Field>
                  <Field label="Added">{photo.date_added}</Field>
                  <Field label="Shoot">{shoot == null ? 'none' : <Link to={`/shoots/${shoot.id}`}>{shoot.folder_path}</Link>}</Field>
                  <Field label="Albums">
                    {photoAlbums.length === 0
                      ? 'none'
                      : photoAlbums.map((a, i) => (
                          <Fragment key={a.id}>
                            {i > 0 && ', '}
                            <Link to={`/albums/${a.id}`}>{a.name}</Link>
                          </Fragment>
                        ))}
                  </Field>
                  <Field label="State">
                    {photo.is_missing ? 'missing' : photo.is_deleted ? 'binned' : 'ok'}
                    {photo.needs_processing ? ' · thumbnailing' : ''}
                  </Field>
                  {photo.processing_error != null && <Field label="Error">{photo.processing_error}</Field>}
                </dl>
                <div className="row detail__actions">
                  <Button render={<a href={originalUrl(photo.id)} />}>
                    <Download size={ICON} />
                    Download RAW
                  </Button>
                  {!photo.is_deleted && (
                    <Button variant="danger" onClick={() => void photos.deletePhotos([photo.id])}>
                      <Trash2 size={ICON} />
                      Bin
                    </Button>
                  )}
                </div>
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
});
