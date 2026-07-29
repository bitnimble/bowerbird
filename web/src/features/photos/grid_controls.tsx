import { observer } from 'mobx-react-lite';
import { useEffect, useRef, useState } from 'react';
import { DayPicker, type DateRange } from 'react-day-picker';
import {
  CalendarRange,
  CircleDashed,
  ImageOff,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  List,
  Search,
  SlidersHorizontal,
  SquareCheck,
  Star,
  ThumbsDown,
  ThumbsUp,
  Unplug,
} from 'lucide-react';
import type { Ordering } from '../../api/client';
import { usePhotosStore, usePresenters } from '../../app/stores_context';
import { Button, CheckMenu, ICON, type Option, PopoverButton, SegmentedControl, Select, Slider, Text, TextField } from '../../ui/ui';
import { activeFilters, type PhotoFilters, type ViewMode } from './photos_store';

const ORDERINGS: Option<Ordering>[] = [
  { value: 'taken_desc', label: 'Newest first' },
  { value: 'taken_asc', label: 'Oldest first' },
  { value: 'added_desc', label: 'Recently added' },
  { value: 'added_asc', label: 'First added' },
];

type ViewKey = 'active' | 'untriaged' | 'picked' | 'rejected' | 'all';

// The five questions a photographer asks constantly, as one-click views.
// "Active" leads because a reject is a decision to stop seeing something, so it
// should leave the working set immediately.
const VIEWS: (Option<ViewKey> & { filters: PhotoFilters })[] = [
  { value: 'active', label: 'Active', icon: <Layers size={ICON} />, filters: activeFilters() },
  { value: 'untriaged', label: 'Untriaged', icon: <CircleDashed size={ICON} />, filters: { triage: ['untriaged'] } },
  { value: 'picked', label: 'Picks', icon: <ThumbsUp size={ICON} />, filters: { triage: ['picked'] } },
  { value: 'rejected', label: 'Rejects', icon: <ThumbsDown size={ICON} />, filters: { triage: ['rejected'] } },
  { value: 'all', label: 'All', icon: <SquareCheck size={ICON} />, filters: {} },
];

// Everything else, behind one button. These union rather than intersect, so
// "picks, unrated and missing" answers "anything I still have to deal with".
type CustomKey = 'untriaged' | 'picked' | 'rejected' | 'unrated' | 'rated' | 'missing' | 'pending';

const CUSTOM: Option<CustomKey>[] = [
  { value: 'untriaged', label: 'Untriaged', icon: <CircleDashed size={ICON} /> },
  { value: 'picked', label: 'Picks', icon: <ThumbsUp size={ICON} /> },
  { value: 'rejected', label: 'Rejects', icon: <ThumbsDown size={ICON} /> },
  { value: 'unrated', label: 'Unrated', icon: <Star size={ICON} /> },
  { value: 'rated', label: 'Rated', icon: <Star size={ICON} /> },
  { value: 'missing', label: 'Missing file', icon: <Unplug size={ICON} /> },
  { value: 'pending', label: 'No thumbnail', icon: <ImageOff size={ICON} /> },
];

function customToFilters(keys: CustomKey[]): PhotoFilters {
  const triage = keys.filter((k): k is 'untriaged' | 'picked' | 'rejected' => k === 'untriaged' || k === 'picked' || k === 'rejected');
  const wantsRated = keys.includes('rated');
  const wantsUnrated = keys.includes('unrated');
  return {
    ...(triage.length > 0 ? { triage } : {}),
    // Both together is "any rating at all", which is no rating filter.
    ...(wantsRated !== wantsUnrated ? { rated: wantsRated } : {}),
    ...(keys.includes('missing') ? { isMissing: true } : {}),
    ...(keys.includes('pending') ? { needsTile: true } : {}),
    match: 'any',
  };
}

// Which Custom options a set of filters corresponds to. The presets are just
// named points in the same space, so selecting one shows its constituents
// already ticked in Custom rather than leaving the menu looking untouched.
function customKeys(filters: PhotoFilters): CustomKey[] {
  return [
    ...(filters.triage ?? []),
    ...(filters.rated === true ? (['rated'] as const) : []),
    ...(filters.rated === false ? (['unrated'] as const) : []),
    ...(filters.isMissing === true ? (['missing'] as const) : []),
    ...(filters.needsTile === true ? (['pending'] as const) : []),
  ];
}

function activeView(filters: PhotoFilters): ViewKey | null {
  const triage = filters.triage ?? [];
  const narrowed = filters.rated != null || filters.isMissing != null || filters.needsTile != null;
  if (narrowed) return null;
  const match = VIEWS.find((v) => {
    const want = v.filters.triage ?? [];
    return want.length === triage.length && want.every((t) => triage.includes(t));
  });
  return match?.value ?? null;
}

const SearchBox = observer(function SearchBox(): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const storeSearch = store.filters.search ?? '';
  const [search, setSearch] = useState(storeSearch);
  // The last value this box wrote to the store. Anything else arriving in the
  // store came from elsewhere (a filter chip, opening another collection), and
  // the box has to follow it.
  const pushed = useRef(storeSearch);

  useEffect(() => {
    if (storeSearch === pushed.current) return;
    // An external change wins over whatever is typed here. Without this the
    // pending debounce below compared a stale local value against the freshly
    // emptied store and wrote the old search straight back.
    pushed.current = storeSearch;
    setSearch(storeSearch);
  }, [storeSearch]);

  // Debounced so typing a filename doesn't fire a request per keystroke.
  useEffect(() => {
    if (search === storeSearch) return;
    const timer = setTimeout(() => {
      pushed.current = search;
      // Read filters at fire time rather than closing over them, so a chip
      // clicked mid-debounce isn't reverted by a stale spread.
      void photos.setFilters({ ...store.filters, search });
    }, 250);
    return () => clearTimeout(timer);
  }, [search, storeSearch, photos, store]);

  return <TextField label="Find by filename" placeholder="Filename" icon={<Search size={ICON} />} value={search} onChange={setSearch} />;
});

function isoDay(date: Date): string {
  // Local parts, not toISOString: a date picked as the 3rd must not become the
  // 2nd for anyone east of UTC.
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function parseDay(iso: string | undefined): Date | undefined {
  if (iso == null) return undefined;
  const [y, m, d] = iso.split('-').map(Number);
  return y == null || m == null || d == null ? undefined : new Date(y, m - 1, d);
}

const DateRangeFilter = observer(function DateRangeFilter(): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const from = store.filters.takenFrom;
  const to = store.filters.takenTo;
  const selected: DateRange | undefined = from == null && to == null ? undefined : { from: parseDay(from), to: parseDay(to) };
  const label = from == null && to == null ? 'Any date' : `${from ?? '…'} → ${to ?? '…'}`;

  return (
    <PopoverButton
      active={selected != null}
      trigger={
        <>
          <CalendarRange size={ICON} />
          {label}
        </>
      }
    >
      <DayPicker
        mode="range"
        selected={selected}
        defaultMonth={parseDay(from)}
        onSelect={(range) =>
          void photos.setFilters({
            ...store.filters,
            takenFrom: range?.from == null ? undefined : isoDay(range.from),
            takenTo: range?.to == null ? undefined : isoDay(range.to),
          })
        }
      />
      <Button
        variant="ghost"
        disabled={selected == null}
        onClick={() => void photos.setFilters({ ...store.filters, takenFrom: undefined, takenTo: undefined })}
      >
        Any date
      </Button>
    </PopoverButton>
  );
});

const CustomFilter = observer(function CustomFilter(): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  const f = store.filters;
  const on = customKeys(f);

  return (
    <CheckMenu
      active={on.length > 0}
      trigger={
        <>
          <SlidersHorizontal size={ICON} />
          Custom{on.length > 0 ? ` (${on.length})` : ''}
        </>
      }
      options={CUSTOM}
      selected={on}
      onToggle={(value, checked) => {
        const next = checked ? [...on, value] : on.filter((k) => k !== value);
        // Nothing ticked is not an empty result set, it is no filter at all.
        void photos.setFilters(next.length === 0 ? { search: f.search } : { ...customToFilters(next), search: f.search });
      }}
    />
  );
});

// The top of the range is one photo across, which is how you look closely at a
// frame without leaving the grid.
const MAX_TILE = 1600;

const TileZoom = observer(function TileZoom(): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  return (
    <span className="controls__zoom">
      <ViewModes />
      <Slider label="Thumbnail size" min={120} max={MAX_TILE} step={20} value={store.thumbSize} onChange={photos.setThumbSize} />
      <Text variant="mono" className="controls__count">
        {store.total === 0 ? 'none' : `${store.pageStart}–${store.pageEnd} of ${store.total}`}
      </Text>
    </span>
  );
});

const MODES: Option<ViewMode>[] = [
  { value: 'grid', label: 'Grid', icon: <LayoutGrid size={ICON} />, iconOnly: true },
  { value: 'masonry', label: 'Masonry', icon: <LayoutDashboard size={ICON} />, iconOnly: true },
  { value: 'list', label: 'List', icon: <List size={ICON} />, iconOnly: true },
];

const ViewModes = observer(function ViewModes(): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();
  return <SegmentedControl label="View mode" options={MODES} value={store.mode} onChange={photos.setMode} />;
});

export const GridControls = observer(function GridControls(): JSX.Element {
  const store = usePhotosStore();
  const { photos } = usePresenters();

  return (
    <div className="controls">
      <SegmentedControl
        label="Filter photos"
        options={VIEWS}
        value={activeView(store.filters)}
        onChange={(key) => {
          const view = VIEWS.find((v) => v.value === key);
          if (view != null) void photos.setFilters({ ...view.filters, search: store.filters.search });
        }}
      />

      <CustomFilter />
      <DateRangeFilter />
      <SearchBox />
      {/* Rendered once the collection has said how it is sorted, which arrives
          with the first page. Showing a value before then would be this control
          inventing one, and it would jump when the real answer landed. */}
      {store.ordering != null && (
        <Select label="Sort photos" options={ORDERINGS} value={store.ordering} onChange={(o) => void photos.setOrdering(o)} />
      )}

      <Button onClick={photos.selectAllOnPage} disabled={store.photos.length === 0}>
        <SquareCheck size={ICON} />
        Select page
      </Button>

      <TileZoom />
    </div>
  );
});
