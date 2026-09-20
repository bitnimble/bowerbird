import * as stylex from '@stylexjs/stylex';
import { Layers2, LayoutDashboard, LayoutGrid, List, SquareCheck, SquareDashed, Star, ThumbsUp, Type } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useListingStore, useMarksStore, usePresenters } from '../../../app/stores_context';
import { MenuCheckItem } from '../../../ui/check_menu';
import { ICON } from '../../../ui/icon';
import { menuSection } from '../../../ui/menu_section';
import type { Option } from '../../../ui/option';
import { OverflowMenu } from '../../../ui/overflow_menu';
import { SegmentedControl } from '../../../ui/segmented_control';
import { Slider } from '../../../ui/slider';
import type { ViewMode } from '../photos_store';
import { GridControlsStrings } from './grid_controls.strings';
import { styles } from './grid_controls.stylex';
import { onScreenSpan } from './photo_grid';

type SelectionKey = 'all' | 'visible';

const SELECTIONS: Option<SelectionKey>[] = [
  { value: 'all', label: GridControlsStrings.selectAll(), icon: <SquareCheck size={ICON} /> },
  { value: 'visible', label: GridControlsStrings.selectVisible(), icon: <SquareDashed size={ICON} /> },
];

/**
 * How the grid is drawn and what it is drawn over, behind the one button at the end of the
 * row. The controls that narrow the collection stay in the row itself: a filter is a
 * question about the photographs and is worth a press to see the answer to, where the tile
 * size and the view mode are settled once and then left alone.
 */
export const GridOverflow = observer(function GridOverflow(): JSX.Element {
  const listing = useListingStore();
  const marks = useMarksStore();
  const { photos } = usePresenters();

  const sections = [
    menuSection({
      label: GridControlsStrings.sectionSelection(),
      options: SELECTIONS,
      onSelect: (which) => {
        if (which === 'all') {
          photos.selectAll();
          return;
        }
        const span = onScreenSpan();
        if (span != null) photos.selectSpan(span);
      },
    }),
    menuSection({
      label: GridControlsStrings.sectionView(),
      // No items of its own: the three modes are one control rather than three rows, since
      // picking one is picking against the other two.
      content: (
        <>
          <div {...stylex.props(styles.menuPanel)}>
            {/* A menu focuses the first tabbable thing it holds, and either of these there
                takes the focus its items need (§18.5). */}
            <SegmentedControl
              label={GridControlsStrings.viewMode()}
              options={MODES}
              value={listing.mode}
              onChange={photos.setMode}
              stretch
              focusable={false}
            />
            <Slider
              label={GridControlsStrings.thumbnailSize()}
              min={1}
              max={listing.maxZoom}
              step={1}
              value={listing.zoom}
              onChange={photos.setZoom}
              focusable={false}
              style={styles.panelSlider}
            />
          </div>
          {/* Statements about what the grid *is* rather than actions on it, so boxes that
              stay ticked rather than rows that fire once. */}
          <MenuCheckItem
            icon={<Type size={ICON} />}
            label={GridControlsStrings.showFilenames()}
            checked={listing.showFilenames}
            onCheckedChange={photos.setShowFilenames}
          />

          {/* The two marks a cull is made of, each drawn over the photograph it
              belongs to - so a reader who has finished judging can have the
              photographs back. */}
          <MenuCheckItem
            icon={<ThumbsUp size={ICON} />}
            label={GridControlsStrings.showTriageBadges()}
            checked={marks.showTriage}
            onCheckedChange={photos.setShowTriage}
          />

          <MenuCheckItem
            icon={<Star size={ICON} />}
            label={GridControlsStrings.showRatingBadges()}
            checked={marks.showRating}
            onCheckedChange={photos.setShowRating}
          />

          {/* Lists every frame of every stack in the one stream (§19.5.4). */}
          <MenuCheckItem
            icon={<Layers2 size={ICON} />}
            label={GridControlsStrings.expandAllStacks()}
            checked={listing.expandStacks}
            onCheckedChange={(on) => void photos.setExpandStacks(on)}
          />
        </>
      ),
    }),
  ];

  return <OverflowMenu label={GridControlsStrings.gridOptions()} sections={sections} />;
});

const MODES: Option<ViewMode>[] = [
  { value: 'grid', label: GridControlsStrings.modeGrid(), icon: <LayoutGrid size={ICON} />, iconOnly: true },
  { value: 'masonry', label: GridControlsStrings.modeMasonry(), icon: <LayoutDashboard size={ICON} />, iconOnly: true },
  { value: 'list', label: GridControlsStrings.modeList(), icon: <List size={ICON} />, iconOnly: true },
];
