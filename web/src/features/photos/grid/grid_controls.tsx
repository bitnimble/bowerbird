import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import {
  ArrowDownNarrowWide,
  ArrowDownWideNarrow,
  CircleDashed,
  Layers,
  SquareCheck,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import { type Ordering } from '../../../../../src/schemas/common';
import { useIsMobile } from '../../../app/device';
import { useListingStore, usePresenters } from '../../../app/stores_context';
import { ICON } from '../../../ui/icon';
import type { Option } from '../../../ui/option';
import { PageLead } from '../../../ui/page';
import { Row } from '../../../ui/row';
import { SegmentedControl } from '../../../ui/segmented_control';
import { Select } from '../../../ui/select';
import { Text } from '../../../ui/text';
import { GridControlsStrings } from './grid_controls.strings';
import { styles } from './grid_controls.stylex';
import { GridFilterMenu } from './grid_filter_menu';
import { GridOverflow } from './grid_overflow';
import { activeFilters, type PhotoFilters } from './photo_filters';
export const ORDERINGS: Option<Ordering>[] = (['taken_desc', 'taken_asc', 'added_desc', 'added_asc'] as const).map(
  (value) => ({ value, label: GridControlsStrings.ordering(value) }),
);

// Which way the sort runs, drawn: bars growing down the icon for an ascending order and
// shrinking for a descending one. Exhaustive over `Ordering`, so a new one has to choose.
const SORT_ICONS: Record<Ordering, JSX.Element> = {
  taken_asc: <ArrowDownNarrowWide size={ICON} />,
  taken_desc: <ArrowDownWideNarrow size={ICON} />,
  added_asc: <ArrowDownNarrowWide size={ICON} />,
  added_desc: <ArrowDownWideNarrow size={ICON} />,
};

type ViewKey = 'active' | 'untriaged' | 'picked' | 'rejected' | 'all';

// The five questions a photographer asks constantly, as one-click views.
// "Active" leads because a reject is a decision to stop seeing something, so it
// should leave the working set immediately.
const VIEWS: (Option<ViewKey> & { filters: PhotoFilters })[] = [
  { value: 'active', label: GridControlsStrings.viewActive(), icon: <Layers size={ICON} />, filters: activeFilters() },
  {
    value: 'untriaged',
    label: GridControlsStrings.viewUntriaged(),
    icon: <CircleDashed size={ICON} />,
    filters: { triage: ['untriaged'] },
  },
  { value: 'picked', label: GridControlsStrings.viewPicks(), icon: <ThumbsUp size={ICON} />, filters: { triage: ['picked'] } },
  {
    value: 'rejected',
    label: GridControlsStrings.viewRejects(),
    icon: <ThumbsDown size={ICON} />,
    filters: { triage: ['rejected'] },
  },
  { value: 'all', label: GridControlsStrings.viewAll(), icon: <SquareCheck size={ICON} />, filters: {} },
];

// Everything else, behind one button. These union rather than intersect, so
// "picks, unrated and missing" answers "anything I still have to deal with".
function activeView(filters: PhotoFilters): ViewKey | null {
  const triage = filters.triage ?? [];
  const narrowed = filters.rated != null || filters.isMissing != null || filters.isHidden === true;
  if (narrowed) return null;
  const match = VIEWS.find((v) => {
    const want = v.filters.triage ?? [];
    return want.length === triage.length && want.every((t) => triage.includes(t));
  });
  return match?.value ?? null;
}

export const GridControls = observer(function GridControls({
  lead = false,
}: {
  /** The page's first row, which leaves room for the sidebar's show button. */
  lead?: boolean;
}): JSX.Element {
  const store = useListingStore();
  const { photos } = usePresenters();
  const mobile = useIsMobile();

  return (
    <Row style={styles.controls}>
      {lead && <PageLead />}
      {/* A phone gets the two a cull is actually made from. The other three are a
          press further into the panel beside them, which is where the reader who
          wants Rejects on a phone already is. */}
      <SegmentedControl
        label={GridControlsStrings.filterPhotos()}
        options={mobile ? VIEWS.filter((v) => v.value === 'active' || v.value === 'untriaged') : VIEWS}
        value={activeView(store.filters)}
        onChange={(key) => {
          const view = VIEWS.find((v) => v.value === key);
          if (view != null) void photos.setFilters({ ...view.filters, search: store.filters.search });
        }}
      />

      <GridFilterMenu />
      {/* Rendered once the collection has said how it is sorted, which arrives
          with the first page. Showing a value before then would be this control
          inventing one, and it would jump when the real answer landed. */}
      {store.ordering != null && (
        <Select
          label={GridControlsStrings.sortedBy(ORDERINGS.find((o) => o.value === store.ordering)?.label ?? '')}
          icon={SORT_ICONS[store.ordering]}
          options={ORDERINGS}
          value={store.ordering}
          onChange={(o) => void photos.setOrdering(o)}
        />
      )}

      <span {...stylex.props(styles.end)}>
        <Text variant="mono" style={styles.count}>
          {GridControlsStrings.photoCount(store.photoTotal)}
        </Text>
        <GridOverflow />
      </span>
    </Row>
  );
});
