import * as stylex from '@stylexjs/stylex';
import { HardDriveDownload } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect } from 'react';
import { PathSegment, route } from '../../../../../src/schemas/route';
import { type Settings, type ViewerRendition } from '../../../../../src/schemas/settings';
import { localDateTime } from '../../../api/dates';
import {
  useAlbumsStore,
  useAppSettingsStore,
  useLibrariesStore,
  useViewerStore,
  usePresenters,
  useReplicationStore,
  useShootsStore,
} from '../../../app/stores_context';
import { Button } from '../../../ui/button';
import { CopyButton } from '../../../ui/copy_button';
import { fileSizeLabel } from '../../../ui/format';
import { ICON } from '../../../ui/icon';
import { TextLink } from '../../../ui/link';
import { Row } from '../../../ui/row';
import { Text } from '../../../ui/text';
import { AlbumsPageStrings } from '../../albums/albums_page.strings';
import { ShootPhotosStrings } from '../../shoots/shoot_photos_page.strings';
import { BulkBarStrings } from '../grid/bulk_bar.strings';
import type { Row as MetaRow } from './edit_rows';
import { EditsPanel } from './edits_panel';
import { MetaPanel } from './meta_panel';
import { DetailRating } from './detail_rating';
import { PENDING, bodyLabel, pendingUntil, shutterLabel, stageLabel, takenLabel } from './detail_labels';
import { PhotoDetailStrings } from './photo_detail_page.strings';
import { styles } from './photo_detail_page.stylex';
import { renditionLabel } from '../renditions';

export const PhotoRating = observer(function PhotoRating({ photoId }: { photoId: string }): JSX.Element {
  return (
    <Row style={styles.rating}>
      <Text variant="label">{PhotoDetailStrings.rating()}</Text>
      <DetailRating photoId={photoId} />
    </Row>
  );
});

export const StaleRendition = observer(function StaleRendition({ photoId }: { photoId: string }): JSX.Element {
  const store = useViewerStore();
  const { photos } = usePresenters();
  const building = store.buildingRendition;

  return (
    // Announced, because it arrives and leaves under the reader rather than on a press:
    // closing the editor puts it up, the rebuild landing takes it away.
    <div {...stylex.props(styles.notice)} role="status">
      <Text variant="muted" as="p" style={styles.noticeText}>
        {PhotoDetailStrings.renditionBehindEdits()}
      </Text>
      <Button
        disabled={store.rerenderTarget == null || building}
        onClick={() => void photos.rerenderRenditions(photoId)}
      >
        {building ? PhotoDetailStrings.rebuildingRendition() : PhotoDetailStrings.rebuildRendition()}
      </Button>
    </div>
  );
});

interface DetailPanelProps {
  photoId: string;
  defaultOpen: boolean;
  style?: stylex.StyleXStyles;
}

export const PhotoEdits = observer(function PhotoEdits({ photoId, defaultOpen, style }: DetailPanelProps): JSX.Element {
  const store = useViewerStore();
  const { photos } = usePresenters();
  useEffect(() => void photos.loadEdits(photoId), [photoId, photos]);

  const detail = store.detailFor(photoId);
  return (
    <EditsPanel
      title={PhotoDetailStrings.edits()}
      doc={store.editsFor(photoId)}
      frame={detail == null ? null : { width: detail.width, height: detail.height }}
      defaultOpen={defaultOpen}
      style={style}
    >
      {/* Under the rows whatever they are, because an undo back to neutral leaves a document
          with nothing to list and a render that is still of the settings before it. */}
      {detail?.rendition_stale === true && <StaleRendition photoId={photoId} />}
    </EditsPanel>
  );
});

export const CameraPanel = observer(function CameraPanel({ photoId, defaultOpen, style }: DetailPanelProps): JSX.Element {
  const pending = pendingUntil(useViewerStore().detailFor(photoId));

  return (
    <MetaPanel
      title={PhotoDetailStrings.camera()}
      defaultOpen={defaultOpen}
      style={style}
      rows={[
        [PhotoDetailStrings.cameraBody(), pending((p) => bodyLabel(p.camera_make, p.camera_model))],
        [
          PhotoDetailStrings.lens(),
          pending((p) => (
            <span {...stylex.props(styles.clip)} title={p.lens_model ?? undefined}>
              {p.lens_model ?? PhotoDetailStrings.notRecorded()}
            </span>
          )),
        ],
        [PhotoDetailStrings.iso(), pending((p) => p.iso ?? PhotoDetailStrings.notRecorded())],
        [
          PhotoDetailStrings.shutter(),
          pending((p) => (p.shutter_speed == null ? PhotoDetailStrings.notRecorded() : shutterLabel(p.shutter_speed))),
        ],
        [
          PhotoDetailStrings.apertureRow(),
          pending((p) => (p.aperture == null ? PhotoDetailStrings.notRecorded() : PhotoDetailStrings.aperture(p.aperture.toFixed(1)))),
        ],
        [
          PhotoDetailStrings.focalLengthRow(),
          pending((p) =>
            p.focal_length == null ? PhotoDetailStrings.notRecorded() : PhotoDetailStrings.focalLength(Math.round(p.focal_length)),
          ),
        ],
        // The camera's own clock, with the zone it was set to where the body
        // recorded one: without that, 5pm in Sydney and 5pm in London are the
        // same string on a trip that spanned both.
        [PhotoDetailStrings.takenRow(), pending((p) => takenLabel(p.date_taken, p.date_taken_offset))],
        [
          PhotoDetailStrings.gps(),
          pending((p) =>
            p.latitude == null || p.longitude == null ?
              PhotoDetailStrings.notRecorded()
            : PhotoDetailStrings.coordinates(p.latitude.toFixed(5), p.longitude.toFixed(5)),
          ),
        ],
      ]}
    />
  );
});

// Which setting wrote the file on screen. `processing_service.target` splits these by
// rendition, so reading one of them for every rendition reports a number that never touched
// the other file.
function qualityLabel(settings: Settings, showing: Exclude<ViewerRendition, 'embedded'>): string {
  const quality = showing === 'max' ? settings.max_rendition_quality : settings.full_rendition_quality;
  return PhotoDetailStrings.qualityValue(quality);
}

// What is actually on screen, which is the only panel that has to hear about a
// frame decoding.
export const RenditionPanel = observer(function RenditionPanel({ photoId, defaultOpen, style }: DetailPanelProps): JSX.Element {
  const store = useViewerStore();
  const settings = useAppSettingsStore();
  const photo = store.detailFor(photoId);
  const pending = pendingUntil(photo);
  const showing = store.showing;
  const shownFile = photo?.renditions?.[showing];
  const shownImage = store.shownImageOf(photoId, showing);

  return (
    <MetaPanel
      title={PhotoDetailStrings.renditionDetails()}
      defaultOpen={defaultOpen}
      style={style}
      rows={[
        // The rendition actually on screen, which is the chosen one when the user
        // has switched away from the photo's own. Always knowable: it is what the
        // viewer asked for, not something a column has to have recorded.
        [PhotoDetailStrings.showing(), renditionLabel(showing)],
        // Named and ordered as in Original file below, so the same fact about two
        // files reads the same way in both panels. The pixels come off the
        // decoded image, the weight off the file the server served it from.
        [
          PhotoDetailStrings.dimensionsRow(),
          shownImage == null ? PENDING : PhotoDetailStrings.dimensions(shownImage.width, shownImage.height),
        ],
        [
          PhotoDetailStrings.fileSize(),
          pending(() => (shownFile?.bytes == null ? PhotoDetailStrings.unknown() : fileSizeLabel(shownFile.bytes))),
        ],
        // The file the server holds, which is what a reader can act on. Firefox
        // is watching an MP4 of the same frame, but that is made in the page and
        // exists nowhere to be downloaded or measured.
        [
          PhotoDetailStrings.format(),
          pending(() => (showing === 'embedded' ? PhotoDetailStrings.formatJpeg() : PhotoDetailStrings.formatAvif())),
        ],
        // The SDR pipeline's output space; an HDR render leaves it for Rec.2020
        // primaries and a PQ transfer.
        [
          PhotoDetailStrings.colourSpace(),
          pending(() => (shownFile?.hdr === true ? PhotoDetailStrings.colourSpaceHdr() : PhotoDetailStrings.colourSpaceSdr())),
        ],
        [
          PhotoDetailStrings.quality(),
          pending(() =>
            showing === 'embedded' ? PhotoDetailStrings.qualityNotApplicable()
            : settings.settings == null ? PhotoDetailStrings.unknown()
            : qualityLabel(settings.settings, showing),
          ),
        ],
        // The camera's JPEG has no file of its own: this is the RAW it is lifted
        // out of, and without the qualifier the row reads as the RAW itself.
        [
          PhotoDetailStrings.path(),
          pending(() => {
            if (shownFile?.path == null) return PhotoDetailStrings.unknown();
            return (
              <>
                {showing === 'embedded' ? PhotoDetailStrings.embeddedPath(shownFile.path) : shownFile.path}
                <CopyButton text={shownFile.path} />
              </>
            );
          }),
        ],
      ]}
    />
  );
});

// The original on disk and what the catalogue has made of it. The only panel
// that reads the shoot and album lists, so renaming either wakes nothing else.
export const RawPanel = observer(function RawPanel({ photoId, defaultOpen, style }: DetailPanelProps): JSX.Element {
  const store = useViewerStore();
  const shoots = useShootsStore();
  const albums = useAlbumsStore();
  const photo = store.detailFor(photoId);
  const pending = pendingUntil(photo);
  const shape = store.photoFor(photoId);
  const shoot = photo?.shoot_id == null ? null : shoots.byId.get(photo.shoot_id);
  // A hidden shoot is not in the listing the store holds (§12.4), and a photograph reached through
  // the Hidden chip names one - so the shoot it is in is fetched rather than read as "none".
  const { shoots: shootsPresenter } = usePresenters();
  const shootId = photo?.shoot_id ?? null;
  useEffect(() => {
    if (shootId != null && shoot == null) void shootsPresenter.ensure(shootId);
  }, [shootId, shoot, shootsPresenter]);
  const photoAlbums = photo == null ? [] : albums.albums.filter((a) => photo.album_ids.includes(a.id));

  return (
    <MetaPanel
      title={PhotoDetailStrings.original()}
      defaultOpen={defaultOpen}
      style={style}
      rows={[
        [PhotoDetailStrings.dimensionsRow(), shape == null ? PENDING : PhotoDetailStrings.dimensions(shape.width, shape.height)],
        [
          PhotoDetailStrings.fileSize(),
          pending((p) => (p.file_size == null ? PhotoDetailStrings.unknown() : fileSizeLabel(p.file_size))),
        ],
        [PhotoDetailStrings.added(), pending((p) => localDateTime(p.date_added) ?? p.date_added)],
        [
          ShootPhotosStrings.shoot(),
          pending(() =>
            shoot == null ? PhotoDetailStrings.none() : (
              <TextLink to={route(PathSegment.shoots(), shoot.id)}>{shoot.folder_path}</TextLink>
            ),
          ),
        ],
        [
          AlbumsPageStrings.albums(),
          pending(() =>
            photoAlbums.length === 0
              ? PhotoDetailStrings.none()
              : photoAlbums.map((a, i) => (
                  <Fragment key={a.id}>
                    {i > 0 && PhotoDetailStrings.albumSeparator()}
                    <TextLink to={route(PathSegment.albums(), a.id)}>{a.name}</TextLink>
                  </Fragment>
                )),
          ),
        ],
        [
          PhotoDetailStrings.state(),
          // Which stage is outstanding rather than merely that one is: the tile is
          // the gallery's and lands in ~125ms, the renditions are the viewer's and
          // take ~1.5s, so "still working" means two rather different waits.
          pending(
            (p) =>
              `${
                p.is_missing ? PhotoDetailStrings.stateMissing()
                : p.is_deleted ? PhotoDetailStrings.stateBinned()
                : PhotoDetailStrings.stateOk()
              }${stageLabel(p)}`,
          ),
        ],
        ...(photo?.processing_error != null ? ([[PhotoDetailStrings.error(), photo.processing_error]] as MetaRow[]) : []),
        // Neither for a row composed rather than imported, which has no file of its own to name.
        [
          PhotoDetailStrings.path(),
          pending((p) => {
            const path = p.original_path ?? p.file_path;
            if (path == null) return PhotoDetailStrings.unknown();
            return (
              <>
                {path}
                <CopyButton text={path} />
              </>
            );
          }),
        ],
        ...(photo != null && !photo.has_original ?
          ([[PhotoDetailStrings.original(), <RemoteOriginal photoId={photo.id} libraryId={photo.library_id} />]] as MetaRow[])
        : []),
      ]}
    />
  );
});

// The RAW is on another device (§7.5). The pictures here came from a peer's
// renditions, which is enough to look at and to judge; the editor is what needs
// the file, so fetching it is offered rather than done.
export const RemoteOriginal = observer(function RemoteOriginal({
  photoId,
  libraryId,
}: {
  photoId: string;
  libraryId: string;
}): JSX.Element {
  const store = useReplicationStore();
  const libraries = useLibrariesStore();
  const { replication } = usePresenters();
  const pull = store.pullFor(photoId);
  const readOnly = libraries.byId.get(libraryId)?.read_only === true;

  if (pull?.state === 'active' || pull?.state === 'queued') {
    const total = pull.bytes_total ?? 0;
    return (
      <>
        {PhotoDetailStrings.fetching()}
        {total > 0 && PhotoDetailStrings.fetchingPercent(Math.round((pull.bytes_done / total) * 100))}
      </>
    );
  }

  return (
    <>
      {PhotoDetailStrings.onAnotherDevice()}
      <Button
        variant="ghost"
        disabled={readOnly}
        title={readOnly ? BulkBarStrings.notOnReadOnlyLibrary() : undefined}
        onClick={() => void replication.fetchOriginal(photoId)}
      >
        <HardDriveDownload size={ICON} />
        {pull?.state === 'failed' ? PhotoDetailStrings.tryAgain() : PhotoDetailStrings.fetchOriginal()}
      </Button>
    </>
  );
});

// The viewer's keyboard layer. Stepping through frames and judging them is the
// whole point of a detail view during a cull, so the verdict keys work here
// exactly as they do in the grid. Separate component so that a keystroke
// re-renders whichever panel owns what it changed, and nothing else.
