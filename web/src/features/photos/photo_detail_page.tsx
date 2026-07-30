import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, useState } from 'react';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Download,
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
import { needsHdrVideo, renditionVideoUrl, viewerUrl, type PhotoDetail, type ViewerRendition } from '../../api/client';
import { captureDateTime, localDateTime } from '../../api/dates';
import {
  useAlbumsStore,
  useAppSettingsStore,
  usePhotosStore,
  usePresenters,
  useShootsStore,
} from '../../app/stores_context';
import { ActionMenu, Button, ICON, MoreLess, type Option, Text, TextArea } from '../../ui/ui';
import { renditionLabel } from './renditions';
import { PhotoStage } from './photo_stage';
import { TRIAGE_KEYS, TriageControl } from './triage_control';

type Row = [label: string, value: React.ReactNode];

// Stands in for a field until the detail fetch lands, so every panel is its
// final height from the first frame.
const PENDING = 'loading';

// Two rows visible, the rest one click away. Every panel then costs the same
// three lines, so the column stays scannable however much a camera recorded.
const VISIBLE_ROWS = 2;

// The panel strip is a grid track the stage is sized against, so it has to hold
// its height across the detail fetch. Every field that fetch answers renders as
// PENDING until it lands rather than the panel not rendering at all: an empty
// strip let the photo paint full-size and then shrink under itself when the
// panels appeared.
function pendingUntil(photo: PhotoDetail | null) {
  return (value: (p: PhotoDetail) => React.ReactNode): React.ReactNode => (photo == null ? PENDING : value(photo));
}

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

// Empty once both passes have landed, which is the usual state.
function stageLabel(photo: PhotoDetail): string {
  if (photo.needs_tile) return ' · building the grid rendition';
  return photo.needs_renditions ? ' · building the rendition this view shows' : '';
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

// Renditions of the same frame rather than commands: each is built once and
// cached, so these read as "which one am I looking at", not "rebuild it now".
// All three stay on offer whichever is showing, including the step back down to
// the camera's JPEG: comparing a render against it is a reason to switch.
const RENDITIONS: Option<ViewerRendition>[] = [
  { value: 'embedded', label: renditionLabel('embedded'), icon: <Sparkles size={ICON} />, hint: 'I' },
  { value: 'full', label: renditionLabel('full'), icon: <Wand2 size={ICON} />, hint: 'O' },
  { value: 'max', label: renditionLabel('max'), icon: <Maximize2 size={ICON} /> },
];

// The same three, plus the RAW they all come from. Named off the list above so a
// rendition cannot be called one thing in the viewer and another in the download
// it produces; the keyboard hints are dropped, since nothing downloads on a key.
const DOWNLOADS: Option<'original' | ViewerRendition>[] = [
  { value: 'original', label: 'Original RAW', icon: <FileType size={ICON} /> },
  ...RENDITIONS.map(({ value, label, icon }) => ({ value, label, icon })),
];

const ACTIONS: Option<'metadata' | 'delete'>[] = [
  { value: 'metadata', label: 'Refresh metadata', icon: <RotateCw size={ICON} /> },
  { value: 'delete', label: 'Move to Bin', icon: <Trash2 size={ICON} />, destructive: true },
];

// Where the reader can go from here, and what can be done to the photo they are
// on. Its own observer so that a rebuild finishing, which flips `building…` on
// and off, does not re-render the frame or the panels beside it.
const DetailNav = observer(function DetailNav({ photoId }: { photoId: string }): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();
  const photo = store.detailFor(photoId);
  const prevId = store.prevPhotoId;
  const nextId = store.nextPhotoId;
  // The grid this photo was opened from - the shoot, the album, the Bin - rather
  // than always the library.
  const back = store.openedFrom;

  return (
    <div className="row detail__nav">
      {/* Still a link, so it can be opened in a tab of its own; the cursor is put
          on this photo on the way out so the grid comes back to it. */}
      <Button render={<Link to={back.path} />} onClick={photos.focusOpenPhoto}>
        <ArrowLeft size={ICON} />
        {back.label}
      </Button>
      <Button iconOnly aria-label="Previous photo" disabled={prevId == null} onClick={() => prevId != null && navigate(`/photos/${prevId}`)}>
        <ChevronLeft size={ICON} />
      </Button>
      <Button iconOnly aria-label="Next photo" disabled={nextId == null} onClick={() => nextId != null && navigate(`/photos/${nextId}`)}>
        <ChevronRight size={ICON} />
      </Button>
      <Text variant="mono">{photo?.file_path ?? ''}</Text>

      <div className="spacer" />

      {/* Which of the three files is on screen: the comparison the detail view
          exists for, so it sits in the bar rather than two levels into a menu. */}
      <ActionMenu
        trigger={
          <>
            <ImageIcon size={ICON} />
            Rendition
          </>
        }
        options={RENDITIONS}
        toggles={[
          {
            label: 'Disable cache when changing rendition',
            icon: <RefreshCw size={ICON} />,
            checked: store.forceRebuild,
            onChange: photos.setForceRebuild,
          },
        ]}
        onSelect={(rendition) => void photos.chooseRendition(photoId, rendition)}
      />
      <ActionMenu
        trigger={
          <>
            <RefreshCw size={ICON} />
            Actions
          </>
        }
        options={ACTIONS}
        onSelect={(action) => {
          if (action === 'delete') {
            void photos.deletePhotos({ photo_ids: [photoId] });
            return;
          }
          void photos.refreshMetadata({ photo_ids: [photoId] });
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
        onSelect={(form) => void photos.download(photoId, form)}
      />
      {store.buildingRendition && <Text variant="mono">building…</Text>}
    </div>
  );
});

// The frame on screen, and the two being warmed either side of it. Everything
// here is about which file to ask for, so it re-renders when that changes and
// not when a panel's data does.
const DetailFrame = observer(function DetailFrame({ photoId }: { photoId: string }): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const photo = store.detailFor(photoId);
  const rendition = store.rendition;
  const showing = store.showing;
  // Every field comes from the same entry, so what is on screen, whether it is
  // HDR and where its bytes live can no longer disagree (§10.2).
  const shownFile = photo?.renditions?.[showing];
  // By the rendition being asked for, so the grid tile's stamp and the viewer's
  // move independently: a rebuild of one does not re-fetch the other.
  const version = store.renditionVersionOf(photoId, showing);
  const stillSrc = viewerUrl(photoId, showing, version);

  // Firefox renders an HDR still dark - it applies a PQ transfer to nothing but
  // video - so it gets the one-frame video of whichever rendition is showing
  // instead (§10.7). The embedded one never has a twin, being an 8-bit SDR JPEG
  // with no headroom to carry, so its still is already right.
  const hdrVideo = needsHdrVideo() && shownFile?.video != null;

  // Stepping through frames is the whole job, so both neighbours are fetched and
  // decoded while this one is being looked at and paint on arrival - backwards
  // through a cull is as common as forwards. The rendition on screen is the one
  // warmed, so a reader set to the camera's JPEG never pays for a render they
  // will not see. Only where the neighbour is sure to have it: a rendition built
  // on request is a 404 until something builds it, and the video twin is a poor
  // guess at what the next photo needs.
  const neighbours = [store.prevPhotoId, store.nextPhotoId];
  const preloadSrcs =
    hdrVideo || !store.isAlwaysBuilt(showing)
      ? undefined
      : neighbours.flatMap((id) => (id == null ? [] : [viewerUrl(id, showing, store.renditionVersionOf(id, showing))]));

  const filename = photo?.file_path.split('/').pop() ?? photoId;

  return (
    /* Keyed off the route, not the loaded detail, so the photo on screen is
       always the one the URL asks for. */
    <PhotoStage
      photoKey={photoId}
      // The panels decide which edge they take from this photo's shape, so until
      // that is known from somewhere the stage is not the size it will be.
      hold={store.photoFor(photoId) == null}
      retryEpoch={store.serverEpoch}
      src={hdrVideo && showing !== 'embedded' ? renditionVideoUrl(photoId, showing, version) : stillSrc}
      video={hdrVideo}
      alt={filename}
      filename={filename}
      preloadSrcs={preloadSrcs}
      onImageLoad={(width, height) => photos.imageShown(photoId, showing, width, height)}
      // Only the library's default is built on sight, and only when it is a
      // stored rendition: the camera's JPEG comes out of the RAW, so a 404 there
      // means the RAW is gone, which building cannot fix. A chosen rendition was
      // built before it was shown, so a 404 there is a real fault rather than a
      // gap.
      onImageMissing={
        rendition != null || showing === 'embedded' ? undefined : () => void photos.buildMissingRendition(photoId, showing)
      }
    />
  );
});

// The verdict and the rating, both off the row: they are right from the first
// frame and stay hittable while the detail is in flight, and judging a photo
// re-renders nothing but this.
const TriagePanel = observer(function TriagePanel({ photoId }: { photoId: string }): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const photo = store.photoFor(photoId);

  return (
    <Panel title="Triage">
      <TriageControl value={photo?.triage ?? 'untriaged'} onChange={(next) => void photos.setTriage(photoId, next)} />

      <div className="row detail__rating">
        <Text variant="label">Rating</Text>
        <div className="stars">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              className={`star${n <= (photo?.rating ?? 0) ? ' on' : ''}`}
              aria-label={`Set rating to ${n}`}
              onClick={() => void photos.setRating(photoId, n === photo?.rating ? 0 : n)}
            >
              ★
            </button>
          ))}
        </div>
      </div>
    </Panel>
  );
});

// Its own component holding its own draft: on the page, a keystroke re-rendered
// every panel and the stage with them.
const NotesPanel = observer(function NotesPanel({ photoId }: { photoId: string }): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const saved = store.detailFor(photoId)?.notes ?? '';
  const [notes, setNotes] = useState(saved);
  // Keyed on the photo alone. Following `notes` as well would let a save that
  // lands after the user has started typing again overwrite the field mid-edit.
  useEffect(() => setNotes(store.detailFor(photoId)?.notes ?? ''), [photoId, store.loadedDetail?.id]);
  const dirty = notes !== saved;

  return (
    <Panel title="Notes">
      <TextArea
        label="Notes"
        placeholder="Add a note"
        value={notes}
        onChange={setNotes}
        onBlur={() => {
          if (dirty) void photos.setNotes(photoId, notes);
        }}
      />
      <Text variant="mono">{dirty ? 'unsaved' : store.notesSavedAt != null ? 'saved' : ''}</Text>
    </Panel>
  );
});

const CameraPanel = observer(function CameraPanel({ photoId, defaultOpen }: { photoId: string; defaultOpen: boolean }): JSX.Element {
  const pending = pendingUntil(usePhotosStore().detailFor(photoId));

  return (
    <MetaPanel
      title="Camera"
      defaultOpen={defaultOpen}
      rows={[
        ['Body', pending((p) => bodyLabel(p.camera_make, p.camera_model))],
        [
          'Lens',
          pending((p) => (
            <span className="meta__clip" title={p.lens_model ?? undefined}>
              {p.lens_model ?? 'not recorded'}
            </span>
          )),
        ],
        ['ISO', pending((p) => p.iso ?? 'not recorded')],
        ['Shutter', pending((p) => (p.shutter_speed == null ? 'not recorded' : shutterLabel(p.shutter_speed)))],
        ['Aperture', pending((p) => (p.aperture == null ? 'not recorded' : `f/${p.aperture.toFixed(1)}`))],
        ['Focal length', pending((p) => (p.focal_length == null ? 'not recorded' : `${Math.round(p.focal_length)}mm`))],
        // The camera's own clock, with the zone it was set to where the body
        // recorded one: without that, 5pm in Sydney and 5pm in London are the
        // same string on a trip that spanned both.
        ['Taken', pending((p) => takenLabel(p.date_taken, p.date_taken_offset))],
        [
          'GPS',
          pending((p) =>
            p.latitude == null || p.longitude == null ? 'not recorded' : `${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}`,
          ),
        ],
      ]}
    />
  );
});

// What is actually on screen, which is the only panel that has to hear about a
// frame decoding.
const RenditionPanel = observer(function RenditionPanel({ photoId, defaultOpen }: { photoId: string; defaultOpen: boolean }): JSX.Element {
  const store = usePhotosStore();
  const settings = useAppSettingsStore();
  const photo = store.detailFor(photoId);
  const pending = pendingUntil(photo);
  const showing = store.showing;
  const shownFile = photo?.renditions?.[showing];
  const shownVideo = needsHdrVideo() ? (shownFile?.video ?? null) : null;
  const shownImage = store.shownImageOf(photoId, showing);

  return (
    <MetaPanel
      title="Rendition details"
      defaultOpen={defaultOpen}
      rows={[
        // The rendition actually on screen, which is the chosen one when the user
        // has switched away from the photo's own. Always knowable: it is what the
        // viewer asked for, not something a column has to have recorded.
        ['Showing', renditionLabel(showing)],
        // Named and ordered as in Original RAW below, so the same fact about two
        // files reads the same way in both panels. The pixels come off the
        // decoded image, the weight off the file the server served it from.
        ['Dimensions', shownImage == null ? PENDING : `${shownImage.width} × ${shownImage.height}`],
        [
          'File size',
          pending(() => {
            const bytes = shownVideo?.bytes ?? shownFile?.bytes;
            return bytes == null ? 'unknown' : fileSizeLabel(bytes);
          }),
        ],
        // The camera's JPEG is passed through untouched, so the encoder settings
        // the other two are built with say nothing about it.
        [
          'Format',
          pending(() =>
            shownVideo != null ? 'AV1 (MP4)' : showing === 'embedded' ? 'JPEG' : 'AVIF',
          ),
        ],
        // The SDR pipeline's output space; an HDR render leaves it for Rec.2020
        // primaries and a PQ transfer.
        ['Colour space', pending(() => (shownFile?.hdr === true ? 'Rec.2020 PQ' : 'sRGB'))],
        [
          'Quality',
          pending(() =>
            showing === 'embedded'
              ? 'N/A'
              : settings.settings == null
                ? 'unknown'
                : `${settings.settings.full_rendition_quantizer} (longest edge ${settings.settings.full_rendition_size}px)`,
          ),
        ],
        // The camera's JPEG has no file of its own: this is the RAW it is lifted
        // out of, and without the qualifier the row reads as the RAW itself.
        ['Path', pending(() => `${shownVideo?.path ?? shownFile?.path ?? 'unknown'}${showing === 'embedded' ? ' (embedded)' : ''}`)],
      ]}
    />
  );
});

// The original on disk and what the catalogue has made of it. The only panel
// that reads the shoot and album lists, so renaming either wakes nothing else.
const RawPanel = observer(function RawPanel({ photoId, defaultOpen }: { photoId: string; defaultOpen: boolean }): JSX.Element {
  const store = usePhotosStore();
  const shoots = useShootsStore();
  const albums = useAlbumsStore();
  const photo = store.detailFor(photoId);
  const pending = pendingUntil(photo);
  const shape = store.photoFor(photoId);
  const shoot = photo?.shoot_id == null ? null : shoots.byId.get(photo.shoot_id);
  const photoAlbums = photo == null ? [] : albums.albums.filter((a) => photo.album_ids.includes(a.id));

  return (
    <MetaPanel
      title="Original RAW"
      defaultOpen={defaultOpen}
      rows={[
        ['Dimensions', shape == null ? PENDING : `${shape.width} × ${shape.height}`],
        ['File size', pending((p) => (p.file_size == null ? 'unknown' : fileSizeLabel(p.file_size)))],
        ['Added', pending((p) => localDateTime(p.date_added) ?? p.date_added)],
        ['Shoot', pending(() => (shoot == null ? 'none' : <Link to={`/shoots/${shoot.id}`}>{shoot.folder_path}</Link>))],
        [
          'Albums',
          pending(() =>
            photoAlbums.length === 0
              ? 'none'
              : photoAlbums.map((a, i) => (
                  <Fragment key={a.id}>
                    {i > 0 && ', '}
                    <Link to={`/albums/${a.id}`}>{a.name}</Link>
                  </Fragment>
                )),
          ),
        ],
        [
          'State',
          // Which stage is outstanding rather than merely that one is: the tile is
          // the gallery's and lands in ~125ms, the renditions are the viewer's and
          // take ~1.5s, so "still working" means two rather different waits.
          pending((p) => `${p.is_missing ? 'missing' : p.is_deleted ? 'binned' : 'ok'}${stageLabel(p)}`),
        ],
        ...(photo?.processing_error != null ? ([['Error', photo.processing_error]] as Row[]) : []),
        ['Path', pending((p) => p.original_path ?? p.file_path)],
      ]}
    />
  );
});

// The viewer's keyboard layer. Stepping through frames and judging them is the
// whole point of a detail view during a cull, so the verdict keys work here
// exactly as they do in the grid. Separate component so that a keystroke
// re-renders whichever panel owns what it changed, and nothing else.
const DetailKeys = observer(function DetailKeys({ photoId }: { photoId: string }): null {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();
  const prevId = store.prevPhotoId;
  const nextId = store.nextPhotoId;
  const back = store.openedFrom.path;

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
      // Fullscreen owns Escape: there it leaves the fullscreen frame, not the photo.
      else if (e.key === 'Escape' && document.fullscreenElement == null) {
        photos.focusOpenPhoto();
        navigate(back);
      } else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prevId, nextId, navigate, back, photoId, photos]);

  return null;
});

// Nothing but the layout and what decides it, so the page itself re-renders once
// per photo rather than on everything each part of it watches.
export const PhotoDetailPage = observer(function PhotoDetailPage(): JSX.Element {
  const { photoId = '' } = useParams();
  const store = usePhotosStore();
  const { photos, appSettings } = usePresenters();

  useEffect(() => {
    void photos.openDetail(photoId);
    void appSettings.load();
  }, [photoId, photos, appSettings]);

  // Only once the read for *this* photo has come back empty. The fetch starts in
  // an effect, so the render that first sees a new id has nothing loaded and
  // nothing in flight - which read as "not found" and tore the whole page down,
  // stage included, for the frame before the effect ran.
  const open = store.open;
  if (open?.id === photoId && open.status === 'missing') {
    return (
      <div className="pad">
        <div className="empty">
          <div className="empty__title">Photo not found</div>
          <Text as="p" variant="muted">
            {open.error}
          </Text>
        </div>
      </div>
    );
  }

  // A wide photo wastes horizontal space if the panel sits beside it, and a tall
  // one wastes vertical space if the panel sits under it. Put the panel on
  // whichever edge leaves the photo biggest.
  //
  // From the loaded grid row when the detail has not arrived: the shape is all
  // the layout needs, and waiting for the fetch to learn it costs a frame of
  // empty stage on every step, warmed neighbour or not.
  const shape = store.photoFor(photoId);
  const landscape = shape == null || shape.width >= shape.height;
  // Beside a portrait the column runs the full height of the page, so every row
  // fits without scrolling; under a landscape it is a 34vh strip and does not.
  const expanded = !landscape;

  return (
    <div className="pad detail-page">
      <DetailKeys photoId={photoId} />
      <DetailNav photoId={photoId} />

      <div className={landscape ? 'detail detail--below' : 'detail detail--beside'}>
        <DetailFrame photoId={photoId} />

        <div className="detail__panels">
          <TriagePanel photoId={photoId} />
          <NotesPanel photoId={photoId} />
          <CameraPanel photoId={photoId} defaultOpen={expanded} />
          <RenditionPanel photoId={photoId} defaultOpen={expanded} />
          <RawPanel photoId={photoId} defaultOpen={expanded} />
        </div>
      </div>
    </div>
  );
});
