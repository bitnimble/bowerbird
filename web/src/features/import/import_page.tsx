import * as stylex from '@stylexjs/stylex';
import { FileImage, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { importJobDone } from '../../../../src/schemas/imports';
import { ShootNameSchema } from '../../../../src/schemas/shoots';
import { importsApi } from '../../api/imports';
import { useImportStore, useLibrariesStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { CheckLabel } from '../../ui/check_label';
import { EmptyState } from '../../ui/empty_state';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { focusRing } from '../../ui/focus_ring';
import { Heading } from '../../ui/heading';
import { ICON } from '../../ui/icon';
import { Page, PageHead } from '../../ui/page';
import { ProgressBar } from '../../ui/progress_bar';
import { Row, Spacer } from '../../ui/row';
import { Select } from '../../ui/select';
import { Spinner } from '../../ui/spinner';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { color, size } from '../../ui/tokens.stylex';
import { FolderBrowser } from '../browse/folder_browser';
import { filenameOf, type ImportEntry } from './import_entries';
import { ImportFilterMenu } from './import_filter_menu';
import { ImportPageStrings } from './import_page.strings';
import { IMPORT_TILE, IMPORT_TILE_GAP, type ImportShootChoice } from './import_store';

const NEW_SHOOT = 'new';
const LIBRARY_ROOT = 'root';

const styles = stylex.create({
  options: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    gap: '16px',
    marginBottom: '12px',
  },
  toolbar: {
    marginBottom: '8px',
  },
  progress: {
    width: '200px',
    display: 'grid',
    gap: '4px',
  },
  message: {
    marginBottom: '8px',
  },
  scroller: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minHeight: 0,
    overflowY: 'auto',
    paddingBottom: size.padB,
  },
  content: {
    position: 'relative',
  },
  row: {
    position: 'absolute',
    left: 0,
    right: 0,
    display: 'flex',
  },
  rowGap: (gap: number) => ({ gap: `${gap}px` }),
  tileEdge: (edge: number) => ({ width: `${edge}px`, height: `${edge}px` }),
  tile: {
    position: 'relative',
    display: 'block',
    flexGrow: 0,
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: size.radius,
    backgroundColor: color.slateSoft,
    cursor: 'pointer',
  },
  unselected: {
    opacity: 0.45,
  },
  picture: {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    display: 'block',
  },
  noPicture: {
    width: '100%',
    height: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: color.boneDim,
  },
  inLibraryOverlay: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(10, 12, 16, 0.55)',
  },
  tick: {
    position: 'absolute',
    top: '6px',
    left: '6px',
    margin: 0,
  },
  foot: {
    position: 'absolute',
    left: '4px',
    right: '4px',
    bottom: '4px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '2px',
  },
  badge: {
    paddingInline: '4px',
    borderRadius: size.radius,
    backgroundColor: 'rgba(10, 12, 16, 0.75)',
    color: color.bone,
    fontSize: '11px',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

export const ImportPage = observer(function ImportPage(): JSX.Element {
  const store = useImportStore();
  const libraries = useLibrariesStore();
  const { imports } = usePresenters();

  useEffect(() => void imports.loadVolumes(), [imports]);
  useEffect(() => void imports.chooseLibrary(), [imports, store.destinations.length]);

  return (
    <Page fill>
      <PageHead withSidebarButton>
        <Heading>{ImportPageStrings.importPhotos()}</Heading>
      </PageHead>
      {!libraries.loading && store.destinations.length === 0 ? (
        <EmptyState title={ImportPageStrings.noWritableLibrary()}>
          <Text as="p" variant="muted">
            {ImportPageStrings.noWritableLibraryHint()}
          </Text>
        </EmptyState>
      ) : (
        <>
          <ImportOptions />
          {store.error != null && <ErrorBanner>{store.error}</ErrorBanner>}
          <JobFailures />
          {store.scan != null && <ScanResults />}
        </>
      )}
    </Page>
  );
});

const ImportOptions = observer(function ImportOptions(): JSX.Element {
  const store = useImportStore();
  const libraries = useLibrariesStore();
  const { imports } = usePresenters();
  const source = imports.source;
  const library = libraries.byId.get(store.libraryId);
  const volumeOptions = [
    { value: '', label: ImportPageStrings.chooseDisk() },
    ...store.volumes.map((volume) => ({ value: volume.path, label: volume.name })),
  ];
  const onVolume = store.volumes.some((volume) => volume.path === source.store.selectedPath);
  const choice = store.shootChoice;

  return (
    <div {...stylex.props(styles.options)}>
      <Field>
        <Text variant="label">{ImportPageStrings.source()}</Text>
        {store.volumes.length > 0 && (
          <Select
            label={ImportPageStrings.chooseDisk()}
            value={onVolume ? source.store.selectedPath : ''}
            options={volumeOptions}
            onChange={(path) => imports.selectVolume(path)}
          />
        )}
        <FolderBrowser
          store={source.store}
          presenter={source.presenter}
          label={ImportPageStrings.source()}
        />
      </Field>
      <Field>
        <Text variant="label">{ImportPageStrings.destination()}</Text>
        <Select
          label={ImportPageStrings.destination()}
          value={store.libraryId}
          options={store.destinations.map((candidate) => ({
            value: candidate.id,
            label: candidate.name,
          }))}
          onChange={(id) => void imports.setLibrary(id)}
        />
      </Field>
      <Field>
        <Text variant="label">{ImportPageStrings.shoot()}</Text>
        <Select
          label={ImportPageStrings.shoot()}
          value={choice.kind === 'shoot' ? choice.id : choice.kind}
          options={[
            { value: LIBRARY_ROOT, label: ImportPageStrings.libraryRoot() },
            ...store.shoots.map((shoot) => ({ value: shoot.id, label: shoot.name })),
            // A root-only library never scans a subfolder, so a new shoot could hold nothing.
            ...(library?.include_subfolders === true
              ? [{ value: NEW_SHOOT, label: ImportPageStrings.newShoot() }]
              : []),
          ]}
          onChange={(value) => imports.setShootChoice(shootChoiceOf(value))}
        />
        {choice.kind === 'new' && (
          <TextField
            verbatim
            label={ImportPageStrings.newShootName()}
            placeholder={ImportPageStrings.newShootName()}
            value={store.newShootName}
            onChange={imports.setNewShootName}
          />
        )}
      </Field>
      <Button
        variant="primary"
        disabled={source.store.selectedPath === '' || store.scanning}
        onClick={() => void imports.scan()}
      >
        {store.scanning ? <Spinner small /> : null}
        {store.scanning ? ImportPageStrings.scanning() : ImportPageStrings.scan()}
      </Button>
    </div>
  );
});

function shootChoiceOf(value: string): ImportShootChoice {
  if (value === LIBRARY_ROOT) return { kind: 'root' };
  if (value === NEW_SHOOT) return { kind: 'new' };
  return { kind: 'shoot', id: value };
}

const JobFailures = observer(function JobFailures(): JSX.Element | null {
  const store = useImportStore();
  const job = store.job;
  if (job == null || store.copying) return null;
  return (
    <>
      {job.failed > 0 && (
        <ErrorBanner>{ImportPageStrings.failedNames(job.failed, job.failed_names)}</ErrorBanner>
      )}
      {job.kept > 0 && (
        <ErrorBanner>{ImportPageStrings.keptNames(job.kept, job.kept_names)}</ErrorBanner>
      )}
    </>
  );
});

const ScanResults = observer(function ScanResults(): JSX.Element {
  const store = useImportStore();

  return (
    <>
      <ImportToolbar />
      {store.scan?.complete === false && (
        <Text as="p" variant="muted" style={styles.message}>
          {ImportPageStrings.someFoldersUnread()}
        </Text>
      )}
      {store.unlistedCount > 0 && (
        <Text as="p" variant="muted" style={styles.message}>
          {ImportPageStrings.unlisted(store.unlistedCount)}
        </Text>
      )}
      {store.files.length === 0 ? (
        <EmptyState title={ImportPageStrings.nothingFound()}>
          {store.unlistedCount === 0 && (
            <Text as="p" variant="muted">
              {ImportPageStrings.nothingFoundHint()}
            </Text>
          )}
        </EmptyState>
      ) : store.entries.length === 0 ? (
        <EmptyState title={ImportPageStrings.nothingMatches()} />
      ) : (
        <ImportGrid />
      )}
    </>
  );
});

const ImportToolbar = observer(function ImportToolbar(): JSX.Element {
  const store = useImportStore();
  const { imports } = usePresenters();
  const job = store.job;
  const done = job == null ? 0 : importJobDone(job);
  const adding = ImportPageStrings.addingCount(done, job?.total ?? 0);
  const namesNewShoot =
    store.shootChoice.kind !== 'new' ||
    ShootNameSchema.safeParse(store.newShootName.trim()).success;

  return (
    <Row style={styles.toolbar}>
      <ImportFilterMenu />
      <Button variant="ghost" onClick={imports.selectAll}>
        {ImportPageStrings.selectAll()}
      </Button>
      <Button variant="ghost" onClick={imports.selectNone}>
        {ImportPageStrings.selectNone()}
      </Button>
      <CheckLabel>
        <input
          {...stylex.props(focusRing.ring)}
          type="checkbox"
          checked={store.merge}
          onChange={(event) => imports.setMerge(event.target.checked)}
        />
        {ImportPageStrings.showPairsAsOne()}
      </CheckLabel>
      <CheckLabel>
        <input
          {...stylex.props(focusRing.ring)}
          type="checkbox"
          checked={store.deleteOriginals}
          onChange={(event) => imports.setDeleteOriginals(event.target.checked)}
        />
        {ImportPageStrings.deleteAfterCopying()}
      </CheckLabel>
      <Spacer />
      <Text variant="muted">
        {ImportPageStrings.selectedCount(store.selectedEntryCount, store.entries.length)}
      </Text>
      {job != null && store.copying ? (
        <>
          <span {...stylex.props(styles.progress)}>
            <Text variant="muted">{adding}</Text>
            <ProgressBar label={adding} value={done} max={job.total} />
          </span>
          <Button
            iconOnly
            aria-label={ImportPageStrings.stopAdding()}
            onClick={() => void imports.stop()}
          >
            <X size={ICON} />
          </Button>
        </>
      ) : (
        <Button
          variant="primary"
          disabled={store.selectedEntryCount === 0 || store.starting || !namesNewShoot}
          onClick={() => void imports.add()}
        >
          {ImportPageStrings.addToLibrary()}
        </Button>
      )}
    </Row>
  );
});

const ImportGrid = observer(function ImportGrid(): JSX.Element {
  const store = useImportStore();
  const { imports } = usePresenters();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scroller.current;
    if (element == null) return;
    // A remount starts at the top, and a store still holding the old offset would draw rows far below it.
    imports.setScrollTop(element.scrollTop);
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.contentRect;
      if (box != null) imports.setViewport(box.width, box.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [imports]);

  const { from, to } = store.visibleSpan;
  const rows: number[] = [];
  for (let row = from; row < to; row++) rows.push(row);

  return (
    <div
      ref={scroller}
      {...stylex.props(styles.scroller)}
      onScroll={(event) => imports.setScrollTop(event.currentTarget.scrollTop)}
    >
      <div {...stylex.props(styles.content)} style={{ height: store.rowCount * store.rowHeight }}>
        {rows.map((row) => (
          <div
            key={row}
            {...stylex.props(styles.row, styles.rowGap(IMPORT_TILE_GAP))}
            style={{ top: row * store.rowHeight, height: IMPORT_TILE }}
          >
            {store.entries.slice(row * store.columns, (row + 1) * store.columns).map((entry) => (
              <ImportTile key={entry.key} entry={entry} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});

const ImportTile = observer(function ImportTile({ entry }: { entry: ImportEntry }): JSX.Element {
  const store = useImportStore();
  const { imports } = usePresenters();
  const selected = store.isSelected(entry);
  const inLibrary = store.isInLibrary(entry);
  const name = filenameOf(entry.lead);

  return (
    <label
      {...stylex.props(
        styles.tile,
        styles.tileEdge(IMPORT_TILE),
        !selected && styles.unselected,
        focusRing.within,
      )}
      title={entry.lead.rel_path}
    >
      {/* Keyed by picture: a tile keeps its key when a filter changes what it draws from. */}
      <TilePicture key={entry.thumbnail?.id} entry={entry} />
      {inLibrary && <span {...stylex.props(styles.inLibraryOverlay)} />}
      <input
        type="checkbox"
        {...stylex.props(styles.tick)}
        aria-label={name}
        checked={selected}
        onChange={() => imports.toggle(entry)}
      />
      <span {...stylex.props(styles.foot)}>
        {inLibrary && (
          <span {...stylex.props(styles.badge)}>{ImportPageStrings.alreadyInLibrary()}</span>
        )}
        {entry.mergedFormats.length > 0 && (
          <span {...stylex.props(styles.badge)}>
            {ImportPageStrings.mergedBadge(entry.mergedFormats)}
          </span>
        )}
        <span {...stylex.props(styles.badge)}>{name}</span>
      </span>
    </label>
  );
});

const TilePicture = observer(function TilePicture({ entry }: { entry: ImportEntry }): JSX.Element {
  const scan = useImportStore().scan;
  const [failed, setFailed] = useState(false);
  if (scan == null || entry.thumbnail == null || failed) {
    return (
      <span {...stylex.props(styles.noPicture)}>
        <FileImage size={ICON * 2} />
      </span>
    );
  }
  return (
    <img
      {...stylex.props(styles.picture)}
      src={importsApi.pictureUrl(scan.id, entry.thumbnail.id)}
      alt=""
      decoding="async"
      onError={() => setFailed(true)}
    />
  );
});
