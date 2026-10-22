import { Menu } from '@base-ui-components/react/menu';
import * as stylex from '@stylexjs/stylex';
import {
  ClipboardCopy,
  ClipboardPaste,
  Download,
  ExternalLink,
  FolderOpen,
  Image,
  RotateCw,
  Trash2,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { type PhotoTarget, type Triage } from '../../../../../src/schemas/photos';
import { canRevealFile } from '../../../api/transport';
import {
  useEditsClipboardStore,
  useLibrariesStore,
  useListingStore,
  useMarksStore,
  usePresenters,
  useReplicationStore,
} from '../../../app/stores_context';
import { ICON } from '../../../ui/icon';
import { MenuItems } from '../../../ui/menu_items';
import { menuStyles } from '../../../ui/menu_styles';
import type { Option } from '../../../ui/option';
import { Section, Sections } from '../../../ui/section';
import { Rating } from '../marks';
import { isComposite, isStack, type TileSubject } from '../photos_store';
import { editPath } from '../viewer/detail_mode';
import { editOption, fetchOriginalThenEdit } from '../viewer/edit_option';
import { PhotoDetailStrings } from '../viewer/photo_detail_page.strings';
import { verdictOptions } from './bulk_bar';
import { BulkBarStrings } from './bulk_bar.strings';
import { InStrip, StripOpensEditor, useOpenPhoto } from './photo_tile';
import { TileMenuContext, type OpenTileMenu } from './tile_menu_context';
import { TileMenuStrings } from './tile_menu.strings';

type OpenAction = 'open' | 'edit';
type EditsAction = 'copy' | 'paste';
type PhotoAction = 'export' | 'reveal' | 'thumbnails' | 'metadata' | 'bin';

interface Opened {
  x: number;
  y: number;
  tile: TileSubject;
  target: PhotoTarget;
  count: number;
  selected: boolean;
}

const styles = stylex.create({
  rating: {
    paddingTop: '4px',
    paddingInline: '9px',
    paddingBottom: '6px',
  },
});

export const TileMenu = observer(function TileMenu({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const listing = useListingStore();
  const { photos } = usePresenters();
  const [opened, setOpened] = useState<Opened | null>(null);

  const open: OpenTileMenu = useCallback(
    (e, tile) => {
      // A long press on the grid is `TouchSweep`'s; the Bin's one action is the bar's Restore.
      if (e.nativeEvent.defaultPrevented || listing.isBin) return;
      const menu = photos.menuTarget(tile);
      if (menu == null) return;
      e.preventDefault();
      // A keyboard's context menu key reports no pointer.
      const keyed = e.clientX === 0 && e.clientY === 0;
      const box = keyed ? e.currentTarget.getBoundingClientRect() : null;
      setOpened({
        x: box?.left ?? e.clientX,
        y: box?.bottom ?? e.clientY,
        tile,
        ...menu,
      });
    },
    [listing, photos],
  );

  const anchor = useMemo(
    () =>
      opened == null
        ? null
        : {
            getBoundingClientRect: () =>
              DOMRect.fromRect({ x: opened.x, y: opened.y, width: 0, height: 0 }),
          },
    [opened],
  );

  return (
    <TileMenuContext.Provider value={open}>
      {children}
      <Menu.Root
        open={opened != null}
        onOpenChange={(next) => {
          if (!next) setOpened(null);
        }}
      >
        <Menu.Portal>
          <Menu.Positioner
            {...stylex.props(menuStyles.positioner)}
            anchor={anchor}
            side="bottom"
            align="start"
            sticky
          >
            <Menu.Popup {...stylex.props(menuStyles.popup)} aria-label={TileMenuStrings.menu()}>
              {opened != null && <TileMenuItems opened={opened} close={() => setOpened(null)} />}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </TileMenuContext.Provider>
  );
});

const TileMenuItems = observer(function TileMenuItems({
  opened: { tile, target, count, selected },
  close,
}: {
  opened: Opened;
  close: () => void;
}): JSX.Element {
  const marks = useMarksStore();
  const clipboard = useEditsClipboardStore();
  const replicationStore = useReplicationStore();
  const libraries = useLibrariesStore();
  const { photos, export: exportPhotos, editsClipboard, replication } = usePresenters();
  const navigate = useNavigate();
  const { pathOf } = useOpenPhoto();
  const inViewer = useContext(InStrip) != null;
  const inEditor = useContext(StripOpensEditor);
  const photo = tile.photo;
  // A stack's row shows one photo and stands for all of them, so a single photo's actions are not its.
  const single = count === 1 && !(tile.kind === 'row' && isStack(photo));
  const { triage, rating }: { triage: Triage | null; rating: number | null } = selected
    ? marks.selectedMarks
    : single
      ? photo
      : { triage: null, rating: null };

  const editHref = editPath(pathOf(photo.id));
  const opening: Option<OpenAction>[] = single
    ? [
        {
          value: 'open',
          label: TileMenuStrings.open(),
          icon: <ExternalLink size={ICON} />,
          link: <Link to={pathOf(photo.id)} replace={inEditor} />,
        },
        ...(inEditor
          ? []
          : [
              editOption({
                // The viewer's rule, off the row: an offloaded original comes back with the open.
                editable: isComposite(photo) || !photo.is_missing || photo.is_offloaded,
                fetchingOriginal: replicationStore.fetching.has(photo.id),
                readOnly: libraries.byId.get(photo.library_id)?.read_only === true,
                unreachable: photo.original_elsewhere === 'unreachable',
                editHref,
                replace: inViewer,
              }),
            ]),
      ]
    : [];
  const fetchThenEdit = (): void => {
    const from = window.location.pathname;
    fetchOriginalThenEdit(replication, photo.id, () => {
      if (window.location.pathname !== from) return;
      close();
      navigate(editHref, { replace: inViewer });
    });
  };
  const editing: Option<EditsAction>[] = [
    ...(single
      ? [
          {
            value: 'copy' as const,
            label: TileMenuStrings.copyEdits(),
            icon: <ClipboardCopy size={ICON} />,
          },
        ]
      : []),
    {
      value: 'paste',
      label: TileMenuStrings.pasteEdits(count),
      icon: <ClipboardPaste size={ICON} />,
      disabled: clipboard.copied == null,
      tooltip: clipboard.copied == null ? TileMenuStrings.nothingCopied() : undefined,
    },
  ];
  const acting: Option<PhotoAction>[] = [
    { value: 'export', label: BulkBarStrings.exportPhotos(), icon: <Download size={ICON} /> },
    ...(single && canRevealFile() && !isComposite(photo)
      ? [
          {
            value: 'reveal' as const,
            label: PhotoDetailStrings.openContainingFolder(),
            icon: <FolderOpen size={ICON} />,
          },
        ]
      : []),
    { value: 'thumbnails', label: BulkBarStrings.rebuildThumbnails(), icon: <Image size={ICON} /> },
    { value: 'metadata', label: BulkBarStrings.refreshMetadata(), icon: <RotateCw size={ICON} /> },
    {
      value: 'bin',
      label: count < 2 ? BulkBarStrings.moveToBin() : BulkBarStrings.moveCountToBin(count),
      icon: <Trash2 size={ICON} />,
      destructive: true,
    },
  ];

  return (
    <Sections>
      {opening.length > 0 && (
        <Section key="open">
          <MenuItems options={opening} onSelect={fetchThenEdit} />
        </Section>
      )}
      <Section key="marks">
        <MenuItems
          options={verdictOptions(triage)}
          onSelect={(verdict) => void photos.markPhotos(target, { triage: verdict })}
        />
        <Rating
          rating={rating}
          onSet={(stars) => void photos.markPhotos(target, { rating: stars })}
          focusable={false}
          style={styles.rating}
        />
      </Section>
      <Section key="edits">
        <MenuItems
          options={editing}
          onSelect={(action) => {
            if (action === 'copy') void editsClipboard.copy(photo.id);
            else void editsClipboard.paste(target, inViewer);
          }}
        />
      </Section>
      <Section key="photos">
        <MenuItems
          options={acting}
          onSelect={(action) => {
            if (action === 'export')
              exportPhotos.openFor(
                target,
                count,
                photo.height > 0 ? { width: photo.width, height: photo.height } : null,
              );
            else if (action === 'reveal') void photos.revealOriginal(photo.id);
            else if (action === 'thumbnails') void photos.rebuildTiles(target);
            else if (action === 'metadata') void photos.refreshMetadata(target);
            else void photos.deletePhotos(target);
          }}
        />
      </Section>
    </Sections>
  );
});
