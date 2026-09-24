import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Fragment, useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, FolderOpen, SlidersHorizontal, X } from 'lucide-react';
import type { EditDoc } from '../../../../src/schemas/photo_edits';
import type { QueuedPhoto } from '../../../../src/schemas/exports';
import { PathSegment, route } from '../../../../src/schemas/route';
import { type ExportedPhoto, type ExportRun } from '../../../../src/schemas/exports';
import { exportsApi } from '../../api/exports';
import { renditionsApi } from '../../api/renditions';
import { localDateTime } from '../../api/dates';
import { useExportHistoryStore, useExportStore, usePresenters } from '../../app/stores_context';
import type { ExportJob } from '../export/export_job';
import { photoPath, renditionVersion } from '../photos/photos_store';
import { Button } from '../../ui/button';
import { EmptyState } from '../../ui/empty_state';
import { focusRing } from '../../ui/focus_ring';
import { relativeTime } from '../../ui/format';
import { Heading } from '../../ui/heading';
import { ICON } from '../../ui/icon';
import { TextLink } from '../../ui/link';
import { List, ListBody, ListName, ListRow, listStyles } from '../../ui/list';
import { menuSection } from '../../ui/menu_section';
import { MetaList, MetaTerm, MetaValue } from '../../ui/meta_list';
import { OverflowMenu } from '../../ui/overflow_menu';
import { Page, PageLead } from '../../ui/page';
import { PopoverButton } from '../../ui/popover_button';
import { ProgressBar } from '../../ui/progress_bar';
import { Text } from '../../ui/text';
import { color, size } from '../../ui/tokens.stylex';
import { editRows } from '../photos/viewer/edit_rows';
import { EditsPanel } from '../photos/viewer/edits_panel';
import { PhotoDetailStrings } from '../photos/viewer/photo_detail_page.strings';
import type { Size } from '../photos/viewer/zoom_pan';
import { ExportsPageStrings } from './exports_page.strings';

// A closed run is a row of the same height as a file's however few tiles it piles up: the height
// of a file's three lines of meta, so a fourth would want this moved with it.
const EXPORT_ROW = '66px';

const styles = stylex.create({
  queue: {
    marginBottom: '20px',
  },
  title: {
    marginBottom: '8px',
  },
  status: {
    marginLeft: 'auto',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    width: '160px',
    display: 'grid',
    gap: '6px',
  },
  runRow: {
    position: 'relative',
    borderBottomWidth: { default: '1px', ':last-child': 0 },
    borderBottomStyle: 'solid',
    borderBottomColor: color.slate,
  },
  runActions: {
    position: 'absolute',
    top: 0,
    right: '10px',
    // The summary's own height, so the button sits on the run's line and not over its opened files.
    height: EXPORT_ROW,
    display: 'flex',
    alignItems: 'center',
  },
  spacer: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    width: size.controlH,
  },
  summary: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    paddingBlock: '7px',
    paddingInline: '10px',
    minHeight: EXPORT_ROW,
    backgroundColor: color.slateSoft,
    cursor: 'pointer',
    listStyle: 'none',
    '::-webkit-details-marker': { display: 'none' },
  },
  row: {
    minHeight: EXPORT_ROW,
  },
  inRun: {
    paddingLeft: '30px',
  },
  meta: {
    gridTemplateColumns: 'max-content 1fr',
  },
  chevron: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    color: color.boneDim,
    transitionProperty: 'transform',
    transitionDuration: '120ms',
    transitionTimingFunction: 'ease',
    transform: { default: null, [stylex.when.ancestor('[open]')]: 'rotate(90deg)' },
  },
  thumb: {
    width: '56px',
    height: '40px',
    objectFit: 'cover',
    borderRadius: '3px',
  },
  // Sized as a single tile so the row is a file's height, the offsets riding up into the padding;
  // the extra width is the offsets, so the count beside it does not sit on the top card.
  stack: {
    position: 'relative',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    width: '68px',
    height: '40px',
  },
  stacked: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    // Two frames of the same scene are otherwise a single smear.
    boxShadow: `0 0 0 1px ${color.ink}`,
  },
  when: {
    marginLeft: 'auto',
    whiteSpace: 'nowrap',
  },
});

// Where photographs have gone (§10.5.1). Each row is what one export was at the time - the
// file it came from, the file it became, and the settings it carried - rather than what the
// photograph behind it has become since.
export const ExportsPage = observer(function ExportsPage(): JSX.Element {
  const store = useExportHistoryStore();
  const queue = useExportStore().queue;
  const { exportHistory } = usePresenters();

  // Re-read as the queue moves: a run that has just finished is a row this page owes the
  // reader, and the only thing that says one landed while they were watching it.
  useEffect(() => void exportHistory.load(), [exportHistory, queue.length]);

  return (
    <Page>
      <Heading>
        <PageLead />
        {ExportsPageStrings.exports()}
      </Heading>

      {/* Headed only against each other: with nothing queued the history is the page, and a
          lone "History" under the page's own title names it twice. */}
      {queue.length > 0 && (
        <>
          <Text variant="label" as="div" style={styles.title}>
            {ExportsPageStrings.inProgress()}
          </Text>
          <List style={styles.queue}>
            {queue.map((job) => (
              <QueueRun key={job.id} job={job} />
            ))}
          </List>
        </>
      )}

      {store.error != null && (
        <Text as="p" variant="muted">
          {store.error}
        </Text>
      )}

      {/* Neither while the list is on its way nor after it failed to arrive: "nothing exported
          yet" is a claim about the reader's own history, and both of those are this page not
          knowing it. */}
      {store.runs.length === 0 && queue.length === 0 && !store.loading && store.error == null && (
        <EmptyState title={ExportsPageStrings.nothingExported()}>
          <Text as="p" variant="muted">
            {ExportsPageStrings.nothingExportedHint()}
          </Text>
        </EmptyState>
      )}

      {store.runs.length > 0 && queue.length > 0 && (
        <Text variant="label" as="div" style={styles.title}>
          {ExportsPageStrings.exportHistory()}
        </Text>
      )}

      {store.runs.length > 0 && (
        <List>
          {store.runs.map((run) => (
            <Fragment key={run.id}>
              {run.photos.length === 1 ? (
                <PhotoRow photo={run.photos[0]!} />
              ) : (
                <Run run={run} />
              )}
            </Fragment>
          ))}
        </List>
      )}
    </Page>
  );
});

// What is being written now, and what is behind it. The dialog closes on the click that queues
// a run, so this and the sidebar are where a run says how far it has got.
//
// Shaped like the history under it: a run of one is the photograph itself, a run of several is
// a line that opens onto them - the same rows, stating the same things about the same files.
const QueueRun = observer(function QueueRun({ job }: { job: ExportJob }): JSX.Element {
  const { export: exports } = usePresenters();
  const stop = job.running ? ExportsPageStrings.stopExport() : ExportsPageStrings.removeFromQueue();
  const button = (
    <Button iconOnly aria-label={stop} title={stop} onClick={() => exports.stop(job.id)} disabled={job.stopping}>
      <X size={ICON} />
    </Button>
  );

  // Before the describe lands, and after one that failed: the run is going either way, so it
  // says how far it has got over the rows it could not fetch.
  if (job.photos.length === 0) {
    return (
      <ListRow style={styles.row}>
        <ListBody />
        <Progress job={job} />
        {button}
      </ListRow>
    );
  }

  if (job.photos.length === 1) {
    return (
      <ExportRow photo={waiting(job.photos[0]!)}>
        <Progress job={job} />
        {button}
      </ExportRow>
    );
  }

  return (
    <div {...stylex.props(styles.runRow)}>
      <details {...stylex.props(stylex.defaultMarker())}>
        <summary {...stylex.props(styles.summary, focusRing.ring)}>
          <ChevronRight size={ICON} {...stylex.props(styles.chevron)} />
          <Stack tiles={job.photos.map(tileOf)} />
          {/* What the run is, where a written one says what it was: the status beside it says
              how far through, which is a different sentence. */}
          <ListName>{ExportsPageStrings.photographs(job.total)}</ListName>
          <Progress job={job} />
          <span {...stylex.props(styles.spacer)} aria-hidden="true" />
        </summary>
        {job.photos.map((photo) => (
          <ExportRow key={photo.photo_id} photo={waiting(photo)} inRun />
        ))}
      </details>
      <span {...stylex.props(styles.runActions)}>{button}</span>
    </div>
  );
});

// How far through, in the same place on a run's line and on a single photograph's row.
const Progress = observer(function Progress({ job }: { job: ExportJob }): JSX.Element {
  const said =
    job.running ?
      job.stopping ? ExportsPageStrings.stoppingExport()
      : ExportsPageStrings.exportingCount(job.settled, job.total)
    : ExportsPageStrings.waitingToExport(job.total);

  return (
    <span {...stylex.props(styles.status)}>
      <ListName>{said}</ListName>
      {/* Only under the run in flight: a bar on a run that has not started reads as one that
          has, and what a queued run is waiting for is the one above it rather than itself.
          Named, because a page with several runs on it has several of these. */}
      {job.running && <ProgressBar label={said} value={job.written} max={job.total} />}
    </span>
  );
});

// A selection's export, closed: a run of four hundred is one line until it is asked about.
// `details` rather than a state and a handler, so it is open to a find-in-page and keyboard
// operable without any of it being written here.
function Run({ run }: { run: ExportRun }): JSX.Element {
  const { exportHistory } = usePresenters();

  return (
    <div {...stylex.props(styles.runRow)}>
      <details {...stylex.props(stylex.defaultMarker())}>
        {/* The native marker is replaced rather than styled: a `summary` only draws one while
            it is a list-item, and this row is a flex line with a time anchored to its end. */}
        <summary {...stylex.props(styles.summary, focusRing.ring)}>
          <ChevronRight size={ICON} {...stylex.props(styles.chevron)} />
          <Stack tiles={run.photos.map((photo) => (photo.has_thumbnail ? exportsApi.thumbnailUrl(photo.id) : null))} />
          <ListName>{ExportsPageStrings.exportedPhotos(run.photos.length)}</ListName>
          <When at={run.exported_at} />
          {/* Holds the width the menu is drawn over, so the time lands in the same column as
              the times of the files below it. Sized off the token the button is. */}
          <span {...stylex.props(styles.spacer)} aria-hidden="true" />
        </summary>
        {run.photos.map((photo) => (
          <PhotoRow key={photo.id} photo={photo} inRun />
        ))}
      </details>
      {/* Beside the disclosure rather than inside it: a summary is itself a control, and a
          button within one is markup a screen reader is free to skip - and it would open the
          run as well as the menu on every press. */}
      <span {...stylex.props(styles.runActions)}>
        <OverflowMenu
          label={ExportsPageStrings.exportActions()}
          sections={[
            menuSection({
              options: [{ value: 'forget', label: ExportsPageStrings.removeFromHistory(), destructive: true }],
              onSelect: () => void exportHistory.forgetRun(run.id),
            }),
          ]}
        />
      </span>
    </div>
  );
}

// What the run holds, as a pile of its first few: a closed run is the same row height as a
// file's, so it gets the same tile rather than a taller one or none.
//
// Drawn back to front, the first file on top - which is the one the summary's own count reads
// against, and the one an eye lands on first when the run is opened.
const STACKED = 3;

function Stack({ tiles }: { tiles: (string | null)[] }): JSX.Element | null {
  const drawn = tiles.filter((tile): tile is string => tile != null).slice(0, STACKED);
  if (drawn.length === 0) return null;

  return (
    <span {...stylex.props(styles.stack)}>
      {drawn.map((tile, depth) => (
        <img
          key={tile}
          {...stylex.props(styles.thumb, styles.stacked)}
          style={{ zIndex: drawn.length - depth, transform: `translate(${depth * 5}px, ${depth * -3}px)` }}
          src={tile}
          alt=""
          loading="lazy"
        />
      ))}
    </span>
  );
}

/**
 * One photograph on this page, written or waiting to be.
 *
 * The same row either way: a queued export and the history entry it becomes are about the same
 * file, and a reader who has to check what is in the queue is asking exactly what they ask of
 * the history. What differs is the picture and the destination, which the two mappings below
 * decide, and the controls, which the caller passes in.
 */
interface RowPhoto {
  photoId: string;
  tile: string | null;
  sourcePath: string;
  libraryId: string | null;
  libraryName: string | null;
  shootId: string | null;
  shootName: string | null;
  /** Where the file went, and null while the run that will write it is still waiting. */
  destination: string | null;
  edits: EditDoc | null;
  frame: Size | null;
}

function ExportRow({
  photo,
  inRun = false,
  children,
}: {
  photo: RowPhoto;
  /** Stepped in, so an open run's files read as belonging to its line rather than as its siblings. */
  inRun?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <ListRow style={[styles.row, inRun && styles.inRun]}>
      <Thumb photo={photo} />
      <ListBody>
        <MetaList style={styles.meta}>
          <MetaTerm>{ExportsPageStrings.original()}</MetaTerm>
          <MetaValue>{photo.sourcePath}</MetaValue>
          <MetaTerm>{ExportsPageStrings.library()}</MetaTerm>
          {/* Where the photograph is now, so a shoot it has been moved to is where the link
              goes. Absent once it has left the catalogue, which the row itself survives:
              nothing to link to, and its own paths still say what was exported. */}
          <MetaValue>
            {photo.libraryId == null ? (
              ExportsPageStrings.photographGone()
            ) : (
              <>
                <TextLink to={route(PathSegment.libraries(), photo.libraryId)}>{photo.libraryName}</TextLink>
                {photo.shootId != null && photo.shootName != null && (
                  <>
                    {' · '}
                    <TextLink to={route(PathSegment.shoots(), photo.shootId)}>{photo.shootName}</TextLink>
                  </>
                )}
              </>
            )}
          </MetaValue>
          {photo.destination != null && (
            <>
              <MetaTerm>{ExportsPageStrings.writtenTo()}</MetaTerm>
              <MetaValue>{photo.destination}</MetaValue>
            </>
          )}
        </MetaList>
      </ListBody>
      <Edits edits={photo.edits} frame={photo.frame} />
      {children}
    </ListRow>
  );
}

// The way to the photograph, so a placeholder stands in where there is no picture yet. One that
// has left the catalogue has nowhere to go, and there an empty frame beside its paths says less
// than the paths do on their own.
function Thumb({ photo }: { photo: RowPhoto }): JSX.Element | null {
  const picture =
    photo.tile == null ?
      <span {...stylex.props(listStyles.bannerNone)} />
    : <img {...stylex.props(listStyles.bannerImage)} src={photo.tile} alt="" loading="lazy" />;
  if (photo.libraryId == null) {
    return photo.tile == null ? null : <span {...stylex.props(listStyles.banner, styles.thumb)}>{picture}</span>;
  }
  return (
    <Link
      {...stylex.props(listStyles.banner, styles.thumb, focusRing.ring)}
      to={photoPath(photo.photoId, null)}
      aria-label={ExportsPageStrings.goToPhoto(photo.sourcePath)}
    >
      {picture}
    </Link>
  );
}

function written(photo: ExportedPhoto): RowPhoto {
  return {
    photoId: photo.photo_id,
    tile: photo.has_thumbnail ? exportsApi.thumbnailUrl(photo.id) : null,
    sourcePath: photo.source_path,
    libraryId: photo.library_id,
    libraryName: photo.library_name,
    shootId: photo.shoot_id,
    shootName: photo.shoot_name,
    destination: photo.output_path,
    edits: photo.edits,
    frame: frameOf(photo),
  };
}

function waiting(photo: QueuedPhoto): RowPhoto {
  return {
    photoId: photo.photo_id,
    tile: tileOf(photo),
    sourcePath: photo.source_path,
    libraryId: photo.library_id,
    libraryName: photo.library_name,
    shootId: photo.shoot_id,
    shootName: photo.shoot_name,
    destination: null,
    edits: photo.edits,
    frame: frameOf(photo),
  };
}

function frameOf(photo: { width: number | null; height: number | null }): Size | null {
  return photo.width == null || photo.height == null ? null : { width: photo.width, height: photo.height };
}

// The grid's own tile: nothing has been rendered for this export yet, and the photograph as the
// library draws it is the picture the reader picked it by. Null before one has been built.
function tileOf(photo: QueuedPhoto): string | null {
  if (photo.tile_built_at == null) return null;
  const stamps = { tile_built_at: photo.tile_built_at, renditions_built_at: null };
  return renditionsApi.url(photo.photo_id, 'grid', renditionVersion(stamps, 'grid'));
}

function PhotoRow({ photo, inRun = false }: { photo: ExportedPhoto; inRun?: boolean }): JSX.Element {
  const { exportHistory } = usePresenters();

  return (
    <ExportRow photo={written(photo)} inRun={inRun}>
      {exportHistory.canReveal && (
        <Button
          iconOnly
          aria-label={PhotoDetailStrings.openContainingFolder()}
          title={PhotoDetailStrings.openContainingFolder()}
          onClick={() => void exportHistory.reveal(photo.output_path)}
        >
          <FolderOpen size={ICON} />
        </Button>
      )}
      <When at={photo.exported_at} />
      <OverflowMenu
        label={ExportsPageStrings.exportActions()}
        sections={[
          menuSection({
            options: [{ value: 'forget', label: ExportsPageStrings.removeFromHistory(), destructive: true }],
            onSelect: () => void exportHistory.forget(photo.id),
          }),
        ]}
      />
    </ExportRow>
  );
}

// Always in the same place - the last thing before the menu, on a run's line and on a file's
// alike - so a column of times reads down the page rather than moving with what each row has.
// `title` carries the instant itself, which "3 h ago" is only ever an approximation of.
function When({ at }: { at: string }): JSX.Element {
  return (
    <Text variant="muted" style={styles.when} title={localDateTime(at) ?? at}>
      {relativeTime(at)}
    </Text>
  );
}

// A press rather than a hover: the same badge is read with a thumb, where there is no hover
// to have, and a popover is the one disclosure both a pointer and a touch can open.
function Edits({ edits, frame }: { edits: EditDoc | null; frame: Size | null }): JSX.Element | null {
  if (edits == null || editRows(edits, frame).length === 0) return null;

  return (
    <PopoverButton
      align="end"
      trigger={
        <>
          <SlidersHorizontal size={ICON} />
          {ExportsPageStrings.edits()}
        </>
      }
    >
      <EditsPanel title={ExportsPageStrings.editsInThisExport()} doc={edits} frame={frame} defaultOpen />
    </PopoverButton>
  );
}
