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
  needsHdrVideo,
  originalUrl,
  renditionUrl,
  renditionVideoUrl,
  viewerUrl,
  type PreviewRendition,
} from '../../api/client';
import { captureDateTime, localDateTime } from '../../api/dates';
import {
  useAlbumsStore,
  usePhotosStore,
  usePresenters,
  useServerConfigStore,
  useShootsStore,
} from '../../app/stores_context';
import { ActionMenu, type ActionGroup, Button, ICON, MoreLess, type Option, Text, TextArea } from '../../ui/ui';
import { renditionLabel } from './photos_presenter';
import { PhotoStage } from './photo_stage';
import { TRIAGE_KEYS, TriageControl } from './triage_control';

type Row = [label: string, value: React.ReactNode];

// Two rows visible, the rest one click away. Every panel then costs the same
// three lines, so the column stays scannable however much a camera recorded.
const VISIBLE_ROWS = 2;

function MetaPanel({ title, rows, defaultOpen }: { title: string; rows: Row[]; defaultOpen: boolean }): JSX.Element {
  // Null until the user has an opinion, so the panel follows the layout's default
  // when the next photo changes it and stops following the moment they toggle it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? defaultOpen;
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
      {hidden > 0 && <MoreLess count={hidden} open={open} onToggle={() => setToggled(!open)} />}
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

// "+11:00" reads as UTC+11 to anyone who has not just been staring at EXIF.
function takenLabel(iso: string | null, offset: string | null): string {
  const wallClock = captureDateTime(iso);
  if (wallClock == null) return 'not recorded';
  return offset == null ? wallClock : `${wallClock} (UTC${offset.replace(/:00$/, '')})`;
}

const DOWNLOADS: Option<'raw' | 'jpeg'>[] = [
  { value: 'raw', label: 'Original RAW', icon: <FileType size={ICON} /> },
  { value: 'jpeg', label: 'JPEG', icon: <FileImage size={ICON} /> },
];

type PhotoAction = PreviewRendition | 'metadata';

const RENDITIONS: Option<PhotoAction>[] = [
  { value: 'embedded', label: 'Embedded JPEG', icon: <Sparkles size={ICON} />, hint: 'I' },
  { value: 'full', label: 'From RAW', icon: <Wand2 size={ICON} />, hint: 'O' },
  { value: 'max', label: 'From RAW (max quality)', icon: <Maximize2 size={ICON} /> },
];

// Renditions of the same frame rather than commands: each is built once and
// cached, so these read as "which one am I looking at", not "rebuild it now".
// All three stay on offer whichever is showing, including the step back down to
// the camera's JPEG: comparing a render against it is a reason to switch.
const ACTIONS: (Option<PhotoAction> | ActionGroup<PhotoAction>)[] = [
  { value: 'metadata', label: 'Refresh metadata', icon: <RotateCw size={ICON} /> },
  { label: 'Image preview', icon: <ImageIcon size={ICON} />, options: RENDITIONS },
];

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
  const [shownImage, setShownImage] = useState<{ width: number; height: number; bytes: number | null } | null>(null);

  useEffect(() => {
    // Settings first: they decide which rendition this photo opens at, and it
    // is fetched once per session, so only the first photo pays for it.
    void appSettings.load().then(() => photos.openDetail(photoId));
    void configPresenter.load();
    // Cleared on the route change rather than when the detail arrives: the panel
    // must stop claiming the previous photo's resolution the moment we navigate,
    // and the new image can take a while to decode.
    setShownImage(null);
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
      else if (e.key === 'i') void photos.chooseRendition(photoId, 'embedded');
      else if (e.key === 'o') void photos.chooseRendition(photoId, 'full');
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

  // Null means the library's default, which the server names: a catalogue that
  // serves the camera's JPEG opens there, one that renders opens at the full-size
  // rendition. Resolving it here keeps the menu and the panel honest about what
  // is on screen without a fourth state to reason about.
  const rendition = store.rendition;
  const showing: PreviewRendition = rendition ?? photo?.default_rendition ?? 'embedded';
  // Every field comes from the same entry, so what is on screen, whether it is
  // HDR and where its bytes live can no longer disagree (§10.2).
  const shownFile = photo?.renditions?.[showing];
  const stillSrc = viewerUrl(photoId, showing, store.rebuiltAt);
  const hdr = shownFile?.hdr === true;

  // Firefox renders an HDR still dark - it applies a PQ transfer to nothing but
  // video - so it gets the one-frame video of whichever rendition is showing
  // instead (§10.7). The embedded one never has a twin, being an 8-bit SDR JPEG
  // with no headroom to carry, so its still is already right.
  const shownVideo = needsHdrVideo() ? (shownFile?.video ?? null) : null;
  const hdrVideo = shownVideo != null;

  // Stepping through frames is the whole job, so the next one is fetched and
  // decoded while this one is being looked at and paints on arrival. Only for the
  // default rendition: a chosen one is built on request, so asking for the next
  // photo's copy before anything has built it is a 404, and the video twin is a
  // poor guess at what the next photo needs.
  const preloadSrc =
    nextId == null || rendition != null || hdrVideo || showing === 'embedded'
      ? undefined
      : renditionUrl(nextId, showing, store.rebuiltAt);

  const shoot = photo?.shoot_id == null ? null : shoots.byId.get(photo.shoot_id);
  const photoAlbums = photo == null ? [] : albums.albums.filter((a) => photo.album_ids.includes(a.id));
  const notesDirty = notes !== (photo?.notes ?? '');
  const thumbs = serverConfig.config?.thumbnails;

  // A wide photo wastes horizontal space if the panel sits beside it, and a tall
  // one wastes vertical space if the panel sits under it. Put the panel on
  // whichever edge leaves the photo biggest.
  //
  // Off the loaded list while the detail is still in flight: the shape decides
  // which edge the panels take, so waiting for the detail to answer it means the
  // stage changes size under a frame that may already be up - the neighbour the
  // stage warmed decodes the moment it is asked for.
  const shape = photo ?? store.photos.find((p) => p.id === photoId) ?? null;
  const landscape = shape == null || shape.width >= shape.height;
  // Beside a portrait the column runs the full height of the page, so every row
  // fits without scrolling; under a landscape it is a 34vh strip and does not.
  const expanded = !landscape;
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
          toggles={[
            {
              label: 'Disable cache when changing preview',
              icon: <RefreshCw size={ICON} />,
              checked: store.forceRebuild,
              onChange: photos.setForceRebuild,
            },
          ]}
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
          photoKey={photoId}
          src={hdrVideo && showing !== 'embedded' ? renditionVideoUrl(photoId, showing, store.rebuiltAt) : stillSrc}
          video={hdrVideo}
          alt={filename}
          filename={filename}
          preloadSrc={preloadSrc}
          onImageLoad={(width, height, bytes) => setShownImage({ width, height, bytes })}
          // Only the library's default is built on sight, and only when it is a
          // stored rendition: the camera's JPEG comes out of the RAW, so a 404
          // there means the RAW is gone, which building cannot fix. A chosen
          // rendition was built before it was shown, so a 404 there is a real
          // fault rather than a gap.
          onImageMissing={
            rendition != null || showing === 'embedded'
              ? undefined
              : () => void photos.buildMissingRendition(photoId, showing)
          }
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
                defaultOpen={expanded}
                rows={[
                  ['Body', bodyLabel(photo.camera_make, photo.camera_model)],
                  ['Lens', photo.lens_model ?? 'not recorded'],
                  ['ISO', photo.iso ?? 'not recorded'],
                  ['Shutter', photo.shutter_speed == null ? 'not recorded' : shutterLabel(photo.shutter_speed)],
                  ['Aperture', photo.aperture == null ? 'not recorded' : `f/${photo.aperture.toFixed(1)}`],
                  ['Focal length', photo.focal_length == null ? 'not recorded' : `${Math.round(photo.focal_length)}mm`],
                  // The camera's own clock, with the zone it was set to where the
                  // body recorded one: without that, 5pm in Sydney and 5pm in
                  // London are the same string on a trip that spanned both.
                  ['Taken', takenLabel(photo.date_taken, photo.date_taken_offset)],
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
                defaultOpen={expanded}
                rows={[
                  // Reports the rendition actually on screen, which is the chosen
                  // one when the user has switched away from the photo's own.
                  // Null on rows thumbnailed before the column existed, which is
                  // "not recorded" rather than "not built".
                  ['Source', rendition == null && photo.rendition_source == null ? 'unknown' : renditionLabel(showing)],
                  // Named and ordered as in Original RAW below, so the same fact
                  // about two files reads the same way in both panels.
                  // Both rows describe what actually arrived rather than what a
                  // column claims: the pixels come off the decoded image, the
                  // weight off the response that carried it.
                  // The video twin is the exception on both counts: its weight is
                  // reported by the server, a media element leaving no timing
                  // entry to read it off.
                  ['Dimensions', shownImage == null ? 'loading' : `${shownImage.width} × ${shownImage.height}`],
                  [
                    'File size',
                    shownVideo != null
                      ? fileSizeLabel(shownVideo.bytes)
                      : shownImage == null
                        ? 'loading'
                        : shownImage.bytes == null
                          ? 'unknown'
                          : fileSizeLabel(shownImage.bytes),
                  ],
                  // The camera's JPEG is passed through untouched, so the encoder
                  // settings the other two are built with say nothing about it.
                  [
                    'Format',
                    shownVideo != null ? 'AV1 (MP4)' : showing === 'embedded' ? 'JPEG' : (thumbs?.format.toUpperCase() ?? 'WEBP'),
                  ],
                  // The server config reports the SDR pipeline's output space; an
                  // HDR render leaves it for Rec.2020 primaries and a PQ transfer.
                  ['Colour space', hdr ? 'Rec.2020 PQ' : (thumbs?.color_space ?? 'sRGB')],
                  [
                    'Quality',
                    showing === 'embedded'
                      ? 'N/A'
                      : thumbs == null
                        ? 'unknown'
                        : `${thumbs.full.quality} (longest edge ${thumbs.full.size}px)`,
                  ],
                  ['Path', shownVideo?.path ?? shownFile?.path ?? 'unknown'],
                ]}
              />

              <MetaPanel
                title="Original RAW"
                defaultOpen={expanded}
                rows={[
                  ['Dimensions', `${photo.width} × ${photo.height}`],
                  ['File size', photo.file_size == null ? 'unknown' : fileSizeLabel(photo.file_size)],
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
                  ['Path', photo.original_path ?? photo.file_path],
                ]}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
});
