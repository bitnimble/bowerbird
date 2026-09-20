import * as stylex from '@stylexjs/stylex';
import { ChevronLeft, ChevronUp, EyeOff, Layers } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type PhotoSummary } from '../../../../../src/schemas/photos';
import { renditionsApi } from '../../../api/renditions';
import { captureDateTime, localDateTime } from '../../../api/dates';
import {
  useListingStore,
  useMarksStore,
  usePresenters,
  useStacksStore,
  useViewerStore,
} from '../../../app/stores_context';
import { focusRing } from '../../../ui/focus_ring';
import { menuStyles } from '../../../ui/menu_styles';
import { Text } from '../../../ui/text';
import { tileMarker } from './grid.stylex';
import { PanoramaIcon } from './panorama_icon';
import { PhotoDetailStrings } from '../viewer/photo_detail_page.strings';
import { PhotoStageStrings } from '../viewer/photo_stage.strings';
import { isComposite, photoPath, renditionVersion } from '../photos_store';
import { PhotoGridStrings } from './photo_grid.strings';
import { PhotoTileMarks } from './photo_tile_marks';
import { PhotoTilePick } from './photo_tile_pick';
import {
  BADGE_ICON,
  bandColourOf,
  foot,
  layoutOf,
  tile,
  type Layout,
} from './photo_grid_styles';

// The id for a row with no file behind it, which has no filename to be named by.
function filename(filePath: string | null, id: string): string {
  return filePath?.split('/').pop() ?? id;
}

// A composite has no file to be named after, so it is named by what it is.
function rowName(photo: PhotoSummary): string {
  return photo.composite_kind != null ?
      PhotoGridStrings.compositeName(photo.frame_count ?? 0, photo.composite_kind)
    : filename(photo.file_path, photo.id);
}

// Which way the viewer's filmstrip runs, or null in the gallery. Masonry keeps two
// pieces of bookkeeping that a tile itself reports - where its line put it, so its
// band can cut its top edge to match, and the cursor scrolled into view - and both
// are answers about the gallery's layout. Reported from a strip, whose cells are
// uniform and on the other axis, they describe a grid nobody is looking at.
//
// The axis rather than a flag because a band opens along the strip: what closes it
// points back at it, which is up in the gallery and sideways along the foot.
export const InStrip = createContext<'x' | 'y' | null>(null);

// The tick box that starts a selection, and the only way into one with the
// pointer: the frame itself opens the photo (§18.3.1). Drawn only while the tile
// is hovered or holds focus, so a grid nobody is choosing from is photographs and
// nothing else.
// isFocused arrives as a prop rather than being read from the store here. Every
// tile reading store.focusIndex meant one shared scalar changing re-rendered the
// whole grid on every arrow key; as a prop, observer's memo lets through only the
// two tiles whose value actually changed.
export const PhotoTile = observer(function PhotoTile({
  photo,
  index,
  isFocused,
  fused,
}: {
  photo: PhotoSummary;
  index: number;
  isFocused: boolean;
  /** Whether this tile's band is the one drawn joined to it (§19.6). */
  fused: boolean;
}): JSX.Element {
  const listing = useListingStore();
  const marks = useMarksStore();
  const stacks = useStacksStore();
  const viewer = useViewerStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(false);
  const inStrip = useContext(InStrip);
  const layout = layoutOf(listing.mode, inStrip);
  const frame = useRef<HTMLDivElement>(null);
  // Masonry packs its lines from each photo's own shape, so the store can only
  // scroll the cursor's *block* into view (`focusContentTop`) - and a block is a
  // hundred photos, so the cursor spent most of a cull off screen with the
  // verdict keys still acting on it. The tile is the only thing that knows where
  // the packing put it.
  //
  // On the two inputs that packing is a function of as well as on the cursor: a
  // zoom or a resize moves the tile without moving the cursor, and the block it
  // is in stays visible, so nothing upstream reports anything to correct.
  useEffect(() => {
    if (!isFocused || listing.mode !== 'masonry' || inStrip) return;
    frame.current?.scrollIntoView({ block: 'nearest' });
  }, [isFocused, listing.mode, listing.tileSize, listing.viewportWidth, inStrip]);
  // A rendition 404s while processing is still writing it, and the announcement
  // is what brings it back: the version is this row's own `date_reprocessed`,
  // which the announcement for this photo writes into it, so a new URL is one
  // tile asking again for itself the moment there is something to fetch. No
  // other tile in the grid observes that field.
  //
  // Nothing polls behind that. A tile whose announcement never arrives stays
  // blank until the user rebuilds it or reloads, which is the cheap failure; a
  // backoff here meant a library whose tiles were all 404ing - one bad path, one
  // cleared data directory - re-requested every tile on screen forever.
  const version = renditionVersion(photo, 'grid');
  const composed = isComposite(photo);
  const src = renditionsApi.url(photo.id, 'grid', version);
  const [failed, setFailed] = useState(false);
  // A tile that failed and has since been told to try again is not failed any
  // more; without this the placeholder outlives the rendition arriving.
  useEffect(() => setFailed(false), [src]);
  const selected = marks.selection.has(index);
  // With something already chosen the grid is picking photographs rather than
  // browsing them, so the frame toggles instead of opening (§18.3.1).
  const selecting = marks.hasSelection;
  const name = rowName(photo);
  // A composite's band is keyed by the composite itself, a stack's by the stack: both are "the
  // rows this tile stands for", and the store holds them in one map.
  const bandKey = composed ? photo.id : photo.stack_id;
  const expanded = bandKey != null && stacks.expansions.has(bandKey);
  const stacked = photo.stack_id != null && photo.stack_size > 1;
  // An ordinary stack's tile has nowhere to lead - it stands for several photographs and shows one
  // of them - so the frame is the disclosure. A composite's is a photograph in its own right, with a
  // rendition and an address of its own, so the frame opens it and the chip is the disclosure.
  const disclosure = stacked && !composed;
  // Open in the strip, this tile is a spine: the band beside it opens with the very
  // photograph it shows, and a strip has no width to say anything twice.
  const spine = inStrip != null && expanded;
  // A spine is `STRIP_SPINE` across, which the chip's usual mark does not fit in.
  const chevron = spine ? 14 : 22;

  // Where this tile ended up on its masonry line, reported for the band it opened
  // (`stackTileBoxes`): the offsets its top edge is cut to, and the height its rows
  // are capped against. The one thing about a band in masonry that cannot be
  // computed: a line grows its tiles from their own shapes, or hands the slack to a
  // spacer, depending on what follows it. Off the tiles that have a band, so at most
  // one per open stack - and re-run on the two inputs the packing is a function of,
  // since a resize or a zoom moves the tile without resizing every one of them.
  const stackId = photo.stack_id;
  useEffect(() => {
    const element = frame.current;
    if (!expanded || listing.mode !== 'masonry' || inStrip || element == null || stackId == null) return;
    // Measured only from inside the callback, where layout has been flushed for
    // the frame already. The same three reads made eagerly here force one, and
    // `tileSize` is written on every pointer move of the zoom drag. Re-observing
    // reports afresh, so nothing is lost by not reading now.
    const observer = new ResizeObserver(() => {
      photos.measuredStackTile(stackId, element.offsetLeft, element.offsetWidth, element.offsetHeight);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, stackId, listing.mode, listing.tileSize, listing.viewportWidth, inStrip, photos]);

  // The frame is a link so a photograph can be opened in a tab of its own from
  // the context menu or a middle click, but its left click belongs to the grid -
  // a cmd-click here is the selection gesture, not the browser's new-tab one - so
  // every case takes the click and the router is driven from inside.
  const onFrameClick = (e: React.MouseEvent): void => {
    e.preventDefault();
    // extendTo moves the cursor itself, so it is not preceded by focusAt.
    if (e.shiftKey) return photos.extendTo(index);
    photos.focusAt(index);
    if (e.metaKey || e.ctrlKey) return photos.toggle(index);
    if (disclosure) return void photos.toggleBand(photo.stack_id!, index);
    if (selecting) return photos.toggle(index);
    navigate(photoPath(photo.id, listing.source));
  };

  // A listitem cannot take aria-selected, so the state rides on the frame's own
  // name as well as on the tick box beside it.
  // A composite counts its frames; a stack counts its members.
  const counted = composed ? (photo.frame_count ?? 0) : stacked ? photo.stack_size : null;
  const label = PhotoGridStrings.tile(selected, counted, name, photo.composite_kind ?? null);

  // What the chip says, whether the tile itself is the disclosure or the chip is:
  // back the way the band opened, and otherwise what kind of a set this is and how
  // many photographs are under it.
  const chip = (
    <>
      {expanded ?
        inStrip === 'x' ?
          <ChevronLeft size={chevron} />
        : <ChevronUp size={chevron} />
      : <Layers size={22} />}
      {!expanded && <span {...stylex.props(tile.count)}>{counted ?? photo.stack_size}</span>}
    </>
  );

  // The image is always mounted and the placeholder sits behind it until
  // something decodes. Swapping the two made each list refresh blink every
  // un-rendered tile: the placeholder came down, the request 404'd again, and it
  // went back up.
  const picture = (
    <>
      <img
        {...stylex.props(pictureStyle(layout, loaded, photo, false))}
        src={src}
        alt=""
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
      {!loaded && <span {...stylex.props(tile.pending)}>{failed ? PhotoStageStrings.noRenditionYet() : null}</span>}
    </>
  );
  // A spine draws none of it: the photograph it stands for is a cell of the band beside it.
  const shown = stacked && spine ? null : picture;
  // The photograph the viewer is showing, marked in the strip along its foot: a strip is a
  // hundred thousand cells long and the reader has to be able to find where they are in it.
  // Never the spine: the photograph it stands for is a cell of the band beside it.
  const open = inStrip != null && !spine && viewer.open?.id === photo.id;
  const cursor = isFocused && !selected && marks.showsCursor;

  return (
    // The set size and position are stated because only a few dozen tiles are in
    // the DOM at once: without them a reader is told it is on "photo 4 of 30"
    // somewhere in a hundred thousand (§18.3.2). The position is also how
    // `onScreenSpan` asks which photos are actually on screen.
    <div
      ref={frame}
      {...stylex.props(
        cellStyle(layout, aspectOf(photo), listing.tileSize, spine),
        tileMarker,
        ringStyle(selected, cursor, open, expanded),
        // Open, the tile is ringed in the colour of the band it opened, which is what pairs
        // the two when several stacks on one row are open.
        expanded && [tile.band, bandColourOf(bandKey == null ? undefined : listing.bandColours.get(bandKey))],
        // Fused: this tile's band is the one immediately below its row, so the two share the
        // edge between them and neither draws it (§19.6).
        expanded && fused && inStrip == null && tile.fused,
        spine && tile.spine,
      )}
      role="listitem"
      aria-setsize={listing.total}
      aria-posinset={index + 1}
      aria-current={open ? 'page' : cursor ? true : undefined}
      aria-busy={shown != null && !loaded}
    >
      {/* A stack's tile is a disclosure rather than a way into a photograph: it
          stands for every photo in the stack rather than the one it shows, so
          there is no address for it to be a link to, and the frame opens its band
          instead - mid-selection too, where the tick box is what picks the row and
          closing the band would otherwise be unreachable. */}
      <div {...stylex.props(photoStyle(layout, spine))}>
        {disclosure ? (
          <button
            type="button"
            {...stylex.props(tile.hit, focusRing.ring)}
            onClick={onFrameClick}
            aria-expanded={expanded}
            aria-label={label}
          >
            {shown}
          </button>
        ) : (
          <a
            {...stylex.props(tile.hit, focusRing.ring)}
            href={photoPath(photo.id, listing.source)}
            onClick={onFrameClick}
            aria-label={label}
          >
            {shown}
          </a>
        )}

        {/* A frame being merged into a panorama: it is about to stop being a row of its own, and
            the merge is minutes, so the tile says it is busy rather than sitting there inert. */}
        {stacks.waitingOnMerge(index, photo.id) && (
          <span {...stylex.props(tile.busy)} aria-hidden="true">
            <span {...stylex.props(tile.spinner, menuStyles.spin)} />
          </span>
        )}

        {/* Marks the tile as a stack and says which way it is; the tile itself is
            the control. Not a target of its own: `pointer-events: none` hands the
            click to the frame underneath so both halves of the tile do the same
            thing (§19.6). On a tile the listing has stopped collapsing it draws
            nothing, and the badge in the foot is the control. */}
        {(stacked || composed || expanded) && (
          <span
            {...stylex.props(
              tile.stack,
              layout === 'list' && tile.stackList,
              expanded && tile.stackOpen,
              (!stacked || composed) && tile.stackClear,
              spine && tile.stackSpine,
            )}
            aria-hidden
          >
            {/* Its own chip inside the overlay: the dim alone leaves the mark
                unreadable over a bright frame. A panorama draws none of it - its tile is
                a photograph, so it wears a badge in its foot like any other row. */}
            {stacked && <span {...stylex.props(tile.chip, spine && tile.chipSpine)}>{chip}</span>}
          </span>
        )}

        {/* A stack's tile stands for every photo under it, not for the one it
            shows: a name, a triage and a rating there would each read as that
            photo's own, and acting on them is what opening the stack is for. */}
        {!stacked && <TileFoot photo={photo} position={index} />}
      </div>

      {/* Nothing a spine has the width to draw: the tick box is wider than the
          whole cell, and a row picked out of the strip is picked from its band. */}
      {!spine && (
        <>
          <PhotoTilePick
            checked={selected}
            name={name}
            onToggle={(e) => {
              // extendTo moves the cursor itself, so it is not preceded by focusAt.
              if (e.shiftKey) return photos.extendTo(index);
              photos.focusAt(index);
              photos.toggle(index);
            }}
          />

          <div {...stylex.props(tile.badges)}>
            {photo.is_missing && (
              <span {...stylex.props(tile.badge, tile.missing)}>{PhotoDetailStrings.stateMissing()}</span>
            )}
            {photo.is_deleted && (
              <span {...stylex.props(tile.badge, tile.deleted)}>{PhotoDetailStrings.stateBinned()}</span>
            )}
            {/* Ungated, unlike the cull's two marks: a reader has to be able to tell which of these
                is put away, a grid holding the hidden beside the live being what the chip is for. */}
            {photo.is_hidden && (
              <span {...stylex.props(tile.badge, tile.hidden)} aria-label={PhotoDetailStrings.stateHidden()}>
                <EyeOff size={BADGE_ICON} />
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
});

// The row of names and marks under a tile. Shared so a band member in list mode
// says as much about itself as any other row does.
const TileFoot = observer(function TileFoot({
  photo,
  position,
}: {
  photo: PhotoSummary;
  /**
   * Where this row sits in the collapsed collection, for the badge that opens the
   * band of a stack down to one visible photograph. Absent on a band's own
   * members, which have no position (§19.6).
   */
  position?: number;
}): JSX.Element {
  const listing = useListingStore();
  const marks = useMarksStore();
  const stacks = useStacksStore();
  const { photos } = usePresenters();
  // Not in the strip. Its cells are short by construction - it is a row along the
  // edge of a photograph, not a page of them - and two thumbs and five dots under
  // each takes the room the picture is there to have. The verdict and the rating
  // are a press away in the bar above, on the photograph the strip is for.
  const inStrip = useContext(InStrip);
  // ordering_date is date_taken under a taken_* ordering and date_added otherwise,
  // and those are not the same kind of timestamp (§11.1).
  // A tile only exists once a page has landed, so the ordering is known by now;
  // reading it as a capture date is the right guess for the one that never is.
  const orderingDate = listing.ordering?.startsWith('added_')
    ? localDateTime(photo.ordering_date)
    : captureDateTime(photo.ordering_date);
  const badgeStackId = listing.stackBadgeId(photo);
  const band = position == null || badgeStackId == null ? null : { stackId: badgeStackId, position };
  const composite = photo.composite_kind ?? null;
  const name = rowName(photo);
  const list = listing.mode === 'list' && inStrip == null;
  const compositeBadge = inStrip == null && composite != null && position != null;
  const badged = compositeBadge || (inStrip == null && band != null);
  // A merge is the scene its frames show, so it goes unnamed under its tile.
  const named = listing.showFilenames && composite !== 'assembly';

  return (
    <div {...stylex.props(foot.foot, list && foot.list, inStrip != null && foot.strip)}>
      {named && (
        <span
          {...stylex.props(
            foot.name,
            list && foot.nameList,
            // Not the slack in a list row, which would put the badge over by the date rather than
            // beside the name it belongs to.
            list && badged && foot.nameListBeforeBadge,
          )}
          title={photo.file_path ?? undefined}
        >
          {name}
        </span>
      )}
      {/* Beside the name at the size of the marks opposite, rather than a chip over the
          picture: a composite's tile is the one photograph on the row nobody has seen before,
          and the corner a chip took is where the foot's own badges already are. */}
      {composite != null && position != null && inStrip == null && (
        <button
          type="button"
          {...stylex.props(foot.badge, named && foot.badgeAfterName, focusRing.ring)}
          aria-expanded={stacks.expansions.has(photo.id)}
          aria-label={PhotoGridStrings.showCompositeFrames(photo.frame_count ?? 0, composite)}
          onClick={() => void photos.toggleBand(photo.id, position, composite)}
        >
          {composite === 'panorama' ?
            <PanoramaIcon size={12} />
          : <Layers size={12} aria-hidden="true" />}
        </button>
      )}
      {band != null && inStrip == null && (
        <button
          type="button"
          {...stylex.props(foot.badge, named && !compositeBadge && foot.badgeAfterName, focusRing.ring)}
          aria-expanded={stacks.expansions.has(band.stackId)}
          aria-label={PhotoGridStrings.showStack(filename(photo.file_path, photo.id))}
          onClick={() => void photos.toggleBand(band.stackId, band.position)}
        >
          <Layers size={12} aria-hidden="true" />
        </button>
      )}
      {/* The date is the list mode's second column, and a strip has no columns:
          drawn there it lands in the scrim over a thumbnail, under the name. */}
      {listing.mode === 'list' && !inStrip && <Text variant="mono">{orderingDate ?? PhotoGridStrings.noDate()}</Text>}
      {listing.showsMarks && !inStrip && (marks.showTriage || marks.showRating) && <PhotoTileMarks photo={photo} />}
    </div>
  );
});

// One member of an open stack.
//
// Selected by id rather than by position, because a collapsed listing numbers
// one row per stack and a member has no position at all. Legitimate because a
// band's members are loaded and on screen: what the virtual grid forbids is an
// id standing in for a row this client has never held (§19.6).
export const BandMember = observer(function BandMember({ photo }: { photo: PhotoSummary }): JSX.Element {
  const listing = useListingStore();
  const marks = useMarksStore();
  const viewer = useViewerStore();
  const { photos } = usePresenters();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(false);
  const inStrip = useContext(InStrip);
  const selected = marks.memberSelected(photo);
  const src = renditionsApi.url(photo.id, 'grid', renditionVersion(photo, 'grid'));
  // A shoot shows the whole stack and dims the members that are not in it, which
  // is the one place a photo appears in a collection it does not belong to.
  const source = listing.source;
  const outside = source?.kind === 'shoot' && photo.shoot_id !== source.shootId;
  const name = filename(photo.file_path, photo.id);

  const layout = layoutOf(listing.mode, inStrip);
  // Marked in the strip like any other cell of it: a photograph opened from a band is still the
  // one the stage is showing, and a strip that rings it everywhere except inside a stack reads as
  // having lost the reader.
  const open = inStrip != null && viewer.open?.id === photo.id;

  return (
    <div
      {...stylex.props(
        cellStyle(layout, aspectOf(photo), listing.tileSize),
        tileMarker,
        // Nothing bounds a masonry band's line - it is full width - so capping the width caps
        // the height through the ratio.
        layout === 'masonry' && tile.capped(aspectOf(photo)),
        ringStyle(selected, false, open, false),
      )}
      role="listitem"
      aria-current={open ? 'page' : undefined}
      aria-busy={!loaded}
    >
      {/* A link for the same reason a tile's frame is one: the context menu and
          the middle click open a member in a tab of its own. */}
      <div {...stylex.props(photoStyle(layout, false))}>
        <a
          {...stylex.props(tile.hit, focusRing.ring)}
          href={photoPath(photo.id, listing.source)}
          onClick={(e) => {
            e.preventDefault();
            if (e.shiftKey) photos.extendMembersTo(photo);
            else if (e.metaKey || e.ctrlKey || marks.hasSelection) photos.toggleMember(photo);
            else navigate(photoPath(photo.id, listing.source));
          }}
          aria-label={PhotoGridStrings.tile(selected, null, name, null)}
        >
          <img
            {...stylex.props(pictureStyle(layout, loaded, photo, outside))}
            src={src}
            alt=""
            loading="lazy"
            onLoad={() => setLoaded(true)}
          />
        </a>

        <TileFoot photo={photo} />
      </div>

      <PhotoTilePick
        checked={selected}
        name={name}
        onToggle={(e) => (e.shiftKey ? photos.extendMembersTo(photo) : photos.toggleMember(photo))}
      />

      {outside && (
        <div {...stylex.props(tile.outside)} aria-hidden>
          <EyeOff size={14} />
          <span>{PhotoGridStrings.notInThisShoot()}</span>
        </div>
      )}
    </div>
  );
});

// The shape a row is drawn at, which is the picture's own - a composite's `width`/`height` are the
// canvas already framed to what its frames cover, so a panorama lays out like anything else.
export function aspectOf(photo: PhotoSummary): number {
  return photo.width / photo.height;
}

// Masonry sizes a cell from the photo's own shape, off the stored dimensions, so no layout is
// ever read back to lay the rows out.
export function cellStyle(layout: Layout, aspect: number, tileSize: number, spine = false): stylex.StyleXStyles {
  switch (layout) {
    case 'grid':
      return [tile.tile, tile.grid];
    case 'masonry':
      return [tile.tile, tile.masonry(aspect, tileSize)];
    case 'list':
      return [tile.tile, tile.list];
    case 'x':
      return [tile.tile, tile.strip, tile.x, spine && tile.spineX];
    case 'y':
      return [tile.tile, tile.strip, tile.y, spine && tile.spineY];
  }
}

// An open stack's tile already wears a ring of the same weight in its band's colour, and that
// colour is the only thing pairing it with the band below it (§19.6).
export function ringStyle(selected: boolean, cursor: boolean, open: boolean, banded: boolean): stylex.StyleXStyles {
  if (open) return [tile.ring, tile.open];
  if (banded) return null;
  if (cursor) return [tile.ring, tile.cursor];
  return selected && [tile.ring, tile.selected];
}

function photoStyle(layout: Layout, spine: boolean): stylex.StyleXStyles {
  return [tile.photo, layout === 'list' && tile.photoList, spine && tile.photoSpine];
}

// A rejected frame stays visible when filtered to, but reads as set aside; so does a member a
// shoot shows whole without holding it.
function pictureStyle(layout: Layout, loaded: boolean, photo: PhotoSummary, outside: boolean): stylex.StyleXStyles {
  return [
    tile.img,
    layout === 'list' && tile.imgList,
    loaded ? tile.imgLoaded : tile.imgPending,
    outside && tile.imgOutside,
    photo.triage === 'rejected' && tile.imgRejected,
  ];
}
