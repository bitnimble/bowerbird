import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Folder, Images, MoreVertical } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { renditionsApi } from '../api/renditions';
import { ActionMenu } from '../ui/action_menu';
import { Button } from '../ui/button';
import { focusRing } from '../ui/focus_ring';
import { ICON } from '../ui/icon';
import { listStyles } from '../ui/list';
import type { Option } from '../ui/option';
import { Text } from '../ui/text';
import { TextField } from '../ui/text_field';
import { color, size } from '../ui/tokens.stylex';
import { CollectionListStrings } from './collection_list.strings';
import type { CollectionListPresenter } from './collection_list_presenter';
import { LIST_ROW_H, type CollectionListStore, type CollectionRow } from './collection_list_store';

const styles = stylex.create({
  fill: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
  },
  scroller: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    // Inside the scroll, as the grid's is: the page gave it up so this could reach the window's edge.
    paddingBottom: size.padB,
  },
  content: {
    position: 'relative',
  },
  window: {
    position: 'absolute',
    insetInline: 0,
    top: 0,
  },
  // `LIST_ROW_H`, because the scroll's height is the row count times it: every part of a row has
  // to fit inside, which is why the rename field is shrunk rather than allowed to grow the row.
  rowHeight: (height: string) => ({ height }),
  openable: {
    cursor: 'pointer',
    backgroundColor: { default: color.slateSoft, ':hover': color.slate },
  },
  // An outline, not a shadow: high-contrast mode drops shadows, and this is the only thing on
  // screen saying where the keyboard is. Inset, as a fixed row height has no room to grow for it.
  cursored: {
    outline: { default: null, ':focus-visible': `2px solid ${color.satin}` },
    outlineOffset: { default: null, ':focus-visible': '-2px' },
  },
  hidden: {
    opacity: 0.45,
  },
  unclaimed: {
    opacity: 0.6,
  },
  virtualName: {
    fontStyle: 'italic',
  },
  unclaimedBanner: {
    display: 'grid',
    placeItems: 'center',
    backgroundImage: 'none',
  },
  depth: {
    display: 'inline-block',
    height: '1px',
    backgroundColor: color.slate,
    marginRight: '8px',
    verticalAlign: 'middle',
  },
  // A chevron button's width, so a leaf lines up with its siblings.
  leaf: {
    width: size.controlH,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  rename: {
    height: '24px',
  },
});

type Store = CollectionListStore<CollectionRow>;
type Presenter = CollectionListPresenter<Store>;

interface Props {
  store: Store;
  presenter: Presenter;
  /**
   * Stable across renders: a fresh arrow per render defeats observer's memo and
   * rebuilds every mounted row on every scroll frame. Null for a row with no menu.
   */
  actionsFor: (row: CollectionRow) => Option<string>[] | null;
  onAction: (row: CollectionRow, action: string) => void;
  /** Sends the scroll back to the top when the list becomes a different list. */
  resetKey?: string;
  /** Drawn above the scroll rather than inside it, so it is always on screen. */
  header?: ReactNode;
}

export const CollectionList = observer(function CollectionList({
  store,
  presenter,
  actionsFor,
  onAction,
  resetKey = '',
  header,
}: Props): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);

  // The one height everything else is arithmetic over. Taken from the observer's
  // own entry rather than by reading the element back, which would be a layout
  // read in a resize handler.
  useEffect(() => {
    const element = scroller.current;
    if (element == null) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry != null) presenter.setViewport(entry.contentRect.height);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [presenter]);

  // Sampled once per frame rather than per event: the scroll position is the one
  // number here read back off the DOM, and a wheel spin fires far more events
  // than there are frames to render them in.
  const pending = useRef(false);
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const element = e.currentTarget;
    if (pending.current) return;
    pending.current = true;
    requestAnimationFrame(() => {
      pending.current = false;
      presenter.setScrollTop(element.scrollTop);
    });
  };

  // The element keeps its own scroll position across a re-render, and row four
  // thousand of one reading says nothing about row four thousand of another, so
  // both readings start from the top. Written to the store as well as to the
  // element: assigning 0 to something already at 0 fires no scroll event, so the
  // store would keep the old offset and translate the window somewhere the
  // scrollbar is not.
  useEffect(() => {
    if (scroller.current != null) scroller.current.scrollTop = 0;
    presenter.setScrollTop(0);
  }, [resetKey, presenter]);

  // Follow the cursor, on every command rather than on the index changing: Flat
  // and Tree list the same shoots in the same order, so switching between them
  // leaves the index alone, and scrolling away from the cursor changes nothing at
  // all - yet both want the list brought back. Declared after the reset above so
  // a reading change with a cursor set lands on the row rather than at the top.
  useEffect(() => {
    const target = store.cursorScrollTop;
    if (scroller.current != null && target != null) scroller.current.scrollTop = target;
  }, [store.cursorSeq, resetKey, store]);

  return (
    <div {...stylex.props(listStyles.list, styles.fill)}>
      <CollectionListKeys store={store} presenter={presenter} scroller={scroller} />
      {header}

      {/* Mirroring makes a library's list as long as its folder tree, so only the
          rows near the viewport are mounted (§18.3.4). The spacer carries the
          full height and the window is translated into place; both are
          scaffolding for the scroll rather than structure, so neither is
          announced. */}
      <div
        {...stylex.props(styles.scroller, focusRing.ring)}
        ref={scroller}
        onScroll={onScroll}
        tabIndex={0}
        role="list"
        aria-label={CollectionListStrings.rowsLabel(store.rows.length)}
      >
        <div {...stylex.props(styles.content)} role="presentation" style={{ height: store.scrollHeight }}>
          <div
            {...stylex.props(styles.window)}
            role="presentation"
            style={{ transform: `translateY(${store.visibleTop}px)` }}
          >
            {store.visibleRowsSlice.map((row, i) => (
              <ListRow
                key={row.key}
                row={row}
                // Against the whole list rather than the few rows mounted, so a
                // reader is told "folder 4,051 of 20,000".
                position={store.visible.from + i + 1}
                total={store.rows.length}
                store={store}
                presenter={presenter}
                actionsFor={actionsFor}
                onAction={onAction}
                scroller={scroller}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
});

// Bound to the window rather than to a row, which is the point: the cursor is a
// value in the store, so it survives the row it names being unmounted by a
// scroll. Its own component so a keystroke re-renders nothing but the two rows
// whose ring moved.
const CollectionListKeys = observer(function CollectionListKeys({
  store,
  presenter,
  scroller,
}: {
  store: Store;
  presenter: Presenter;
  scroller: React.RefObject<HTMLDivElement>;
}): null {
  const navigate = useNavigate();

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      const target = e.target as HTMLElement | null;
      // A rename in progress owns the arrows, and a browser shortcut owns them
      // whatever is on screen.
      if (target != null && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      // Menus portal outside the list; the sidebar and the view control keep their
      // own arrows. Only once the list has focus do these keys mean the cursor.
      const fromList = target == null || target === document.body || scroller.current?.contains(target) === true;

      switch (e.key) {
        case 'ArrowDown':
          if (!fromList) return;
          presenter.moveCursor(1);
          break;
        case 'ArrowUp':
          if (!fromList) return;
          presenter.moveCursor(-1);
          break;
        case 'ArrowRight':
          if (!fromList) return;
          presenter.openCursor();
          break;
        case 'ArrowLeft':
          if (!fromList) return;
          presenter.closeCursor();
          break;
        case 'Home':
          if (!fromList) return;
          presenter.moveCursor(-store.rows.length);
          break;
        case 'End':
          if (!fromList) return;
          presenter.moveCursor(store.rows.length);
          break;
        // What a click does, for the keyboard.
        case 'Enter': {
          // A focused chevron or ⋮ owns its own Enter.
          if (!fromList || target?.tagName === 'BUTTON') return;
          const href = store.cursorRow?.href;
          if (href == null) return;
          navigate(href);
          break;
        }
        default:
          return;
      }
      // Only once a key was one of ours: the arrows still scroll the page when
      // the cursor is not what the reader is driving.
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenter, store, navigate, scroller]);

  return null;
});

const ListRow = observer(function ListRow({
  row,
  position,
  total,
  store,
  presenter,
  actionsFor,
  onAction,
  scroller,
}: {
  row: CollectionRow;
  position: number;
  total: number;
  store: Store;
  presenter: Presenter;
  actionsFor: (row: CollectionRow) => Option<string>[] | null;
  onAction: (row: CollectionRow, action: string) => void;
  scroller: React.RefObject<HTMLDivElement>;
}): JSX.Element {
  const navigate = useNavigate();
  const element = useRef<HTMLDivElement>(null);

  // Scrolling unmounts the row under the reader's focus, and a removed element
  // drops focus on the document body - after which the next Tab starts from the
  // top of the page. Handing it back to the list keeps the reader where they
  // were, and the list brings the cursor into view when it takes focus.
  //
  // Layout effect, because its cleanup is the last moment the row is still in the
  // document to be asked whether it holds the focus.
  useLayoutEffect(
    () => () => {
      if (element.current?.contains(document.activeElement) === true) scroller.current?.focus();
    },
    [scroller],
  );
  // A shoot shows its first photo from the moment it has one, which is before
  // the import has built that photo's tile, so the banner is routinely asked for
  // a file that is not there yet. Held per photo id rather than as a flag, so a
  // different banner is tried rather than tarred by the last one's failure.
  const [missingBanner, setMissingBanner] = useState<string | null>(null);
  const banner = row.bannerPhotoId == null || row.bannerPhotoId === missingBanner ? null : row.bannerPhotoId;
  const expanded = store.expanded.has(row.key);
  const editing = store.renamingKey === row.key;
  const cursored = store.cursorKey === row.key;
  const hidden = row.tone === 'hidden';
  const unclaimed = row.tone === 'untracked' || row.tone === 'virtual';
  const options = actionsFor(row);

  // Keyboard (and click-within-list) moved the cursor here: take focus so Enter
  // and the next arrow stay with the row. Once per cursorSeq, so a remount of a
  // still-cursored row (scrolled off, tabbed elsewhere, scrolled back) does not
  // steal focus. Skip when focus is outside the list or already inside this row.
  useLayoutEffect(() => {
    if (!cursored) return;
    if (!presenter.claimCursorFocus()) return;
    const self = element.current;
    if (self == null) return;
    const active = document.activeElement;
    if (self.contains(active)) return;
    if (active != null && active !== document.body && scroller.current?.contains(active) !== true) return;
    self.focus({ preventScroll: true });
  }, [cursored, store.cursorSeq, scroller, presenter]);

  return (
    <div
      {...stylex.props(
        listStyles.row,
        styles.rowHeight(`${LIST_ROW_H}px`),
        row.href != null && styles.openable,
        focusRing.ring,
        cursored && styles.cursored,
      )}
      ref={element}
      role="listitem"
      aria-posinset={position}
      aria-setsize={total}
      aria-level={row.depth + 1}
      // Says which row the keyboard is on, which the ring alone only tells a
      // reader who can see it.
      aria-current={cursored ? 'true' : undefined}
      // Roving: exactly one row is ever in the tab order, so while the cursor is
      // on screen, tabbing into the list lands on it.
      tabIndex={cursored ? 0 : -1}
      // Click, not focus and not pointerdown. Focus arrives at a row for reasons
      // that are not the reader choosing it - tabbing forward after a scroll
      // unmounted the row they were in lands on whichever row happens to be
      // mounted, and moving the cursor there would throw away the place they
      // were keeping. Pointerdown fires at the start of a touch flick too, so a
      // scroll would drag the cursor along under the finger; a click is only a
      // tap, the browser having already withheld it from the pan.
      onClick={(e) => {
        const target = e.target as HTMLElement;
        // The ⋮ menu portals its popup out to the body, and a React portal still
        // bubbles its clicks up the component tree: without this, choosing Delete
        // opens the shoot on the way to the dialog.
        if (element.current?.contains(target) !== true) return;
        presenter.setCursor(row.key);
        if (target.closest('button, input') != null) return;
        if (row.href != null) navigate(row.href);
      }}
    >
      <span {...stylex.props(styles.depth)} style={{ width: row.depth * 16 }} />

      {row.expandable ? (
        <Button
          iconOnly
          aria-label={expanded ? CollectionListStrings.collapse(row.name) : CollectionListStrings.expand(row.name)}
          aria-expanded={expanded}
          onClick={() => presenter.toggleExpanded(row.key)}
        >
          {expanded ? <ChevronDown size={ICON} /> : <ChevronRight size={ICON} />}
        </Button>
      ) : store.nests ? (
        <span aria-hidden="true" {...stylex.props(styles.leaf)} />
      ) : (
        <span {...stylex.props(styles.depth)} style={{ width: 0 }} />
      )}

      <span {...stylex.props(listStyles.banner, hidden && styles.hidden)} aria-hidden="true">
        {banner == null ? (
          <span {...stylex.props(listStyles.bannerNone, unclaimed && [styles.unclaimed, styles.unclaimedBanner])}>
            {row.tone === 'virtual' ?
              <Images size={ICON} />
            : row.tone === 'untracked' && <Folder size={ICON} />}
          </span>
        ) : (
          <img
            {...stylex.props(listStyles.bannerImage)}
            src={renditionsApi.url(banner, 'grid')}
            alt=""
            onError={() => setMissingBanner(banner)}
          />
        )}
      </span>

      <div {...stylex.props(listStyles.body, hidden && styles.hidden)}>
        {editing ? (
          <TextField
            grow
            autoFocus
            label={CollectionListStrings.renameField(row.name)}
            value={store.renameDraft}
            onChange={presenter.setRenameDraft}
            onBlur={() => void presenter.commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void presenter.commitRename();
              if (e.key === 'Escape') presenter.cancelRename();
            }}
            style={styles.rename}
          />
        ) : (
          <span
            {...stylex.props(
              listStyles.name,
              unclaimed && styles.unclaimed,
              row.tone === 'virtual' && styles.virtualName,
            )}
          >
            {row.name}
          </span>
        )}
        {/* A row being renamed trades its subtitle for the field, rather than spilling into its neighbours. */}
        {row.meta !== '' && !editing && (
          <Text variant="mono" as="div">
            {row.meta}
          </Text>
        )}
      </div>

      {options != null && (
        <ActionMenu
          iconOnly
          trigger={<MoreVertical size={ICON} />}
          label={CollectionListStrings.actionsFor(row.name)}
          options={options}
          onSelect={(action) => onAction(row, action)}
        />
      )}
    </div>
  );
});
