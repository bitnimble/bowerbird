import * as stylex from '@stylexjs/stylex';
import { Aperture, Camera, ChevronRight, CircleDashed, EyeOff, Filter, Star, ThumbsDown, ThumbsUp, Unplug } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { Popover } from '@base-ui-components/react/popover';
import { useListingStore, usePresenters } from '../../../app/stores_context';
import { Button } from '../../../ui/button';
import { focusRing } from '../../../ui/focus_ring';
import { ICON } from '../../../ui/icon';
import { menuStyles } from '../../../ui/menu_styles';
import type { Option } from '../../../ui/option';
import { PopoverButton } from '../../../ui/popover_button';
import { Section, Sections } from '../../../ui/section';
import type { PhotoFilters } from './photo_filters';
import { GridSearchBox } from './grid_search_box';
import { GridControlsStrings } from './grid_controls.strings';
import { styles } from './grid_controls.stylex';
import { GridDateRangeFilter } from './grid_calendar';

type CustomKey = 'untriaged' | 'picked' | 'rejected' | 'unrated' | 'rated' | 'missing' | 'hidden';

const CUSTOM: Option<CustomKey>[] = [
  { value: 'untriaged', label: GridControlsStrings.viewUntriaged(), icon: <CircleDashed size={ICON} /> },
  { value: 'picked', label: GridControlsStrings.viewPicks(), icon: <ThumbsUp size={ICON} /> },
  { value: 'rejected', label: GridControlsStrings.viewRejects(), icon: <ThumbsDown size={ICON} /> },
  { value: 'unrated', label: GridControlsStrings.customUnrated(), icon: <Star size={ICON} /> },
  { value: 'rated', label: GridControlsStrings.customRated(), icon: <Star size={ICON} fill="currentColor" /> },
  { value: 'missing', label: GridControlsStrings.customMissingFile(), icon: <Unplug size={ICON} /> },
  { value: 'hidden', label: GridControlsStrings.customHidden(), icon: <EyeOff size={ICON} /> },
];

// The tick list owns the chips and nothing else, so a tick keeps the filename, the
// date range and the two model lists, which are the other controls in this panel.
function withCustom(filters: PhotoFilters, keys: CustomKey[]): PhotoFilters {
  const kept: PhotoFilters = {
    search: filters.search,
    takenFrom: filters.takenFrom,
    takenTo: filters.takenTo,
    cameraModels: filters.cameraModels,
    lensModels: filters.lensModels,
  };
  // Nothing ticked is not an empty result set, it is no chip at all.
  return keys.length === 0 ? kept : { ...kept, ...customToFilters(keys) };
}

function customToFilters(keys: CustomKey[]): PhotoFilters {
  const triage = keys.filter((k): k is 'untriaged' | 'picked' | 'rejected' => k === 'untriaged' || k === 'picked' || k === 'rejected');
  const wantsRated = keys.includes('rated');
  const wantsUnrated = keys.includes('unrated');
  return {
    ...(triage.length > 0 ? { triage } : {}),
    // Both together is "any rating at all", which is no rating filter.
    ...(wantsRated !== wantsUnrated ? { rated: wantsRated } : {}),
    ...(keys.includes('missing') ? { isMissing: true } : {}),
    // Only ever ticked: hiding is the default the other ticks are read against, so there is no
    // "not hidden" to ask for.
    ...(keys.includes('hidden') ? { isHidden: true } : {}),
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
    ...(filters.isHidden === true ? (['hidden'] as const) : []),
  ];
}

type ModelList = 'camera' | 'lens';

function openedList(row: ModelList, open: boolean, current: ModelList | null): ModelList | null {
  if (open) return row;
  // Moving from one row to the other closes the first *after* the second has opened, so a
  // close is only its own row's to act on.
  return current === row ? null : current;
}

/**
 * The bodies, or the lenses, the collection was shot with, as a list that opens beside the
 * panel rather than in it: a well-travelled library runs to dozens of either, and a panel
 * that tall is one the calendar under it falls off the screen with.
 *
 * A lens that was never on a ticked body is offered greyed rather than left out: the pair
 * lists nothing, and a row that vanished as the reader ticked elsewhere is a list they
 * cannot learn the shape of.
 */
const ModelFilter = observer(function ModelFilter({
  which,
  label,
  icon,
  open,
  onOpen,
}: {
  which: ModelList;
  label: string;
  icon: JSX.Element;
  // Which list is open is the panel's to hold, not each row's: two lists open at once
  // sit on top of each other, where a menu's submenus take turns.
  open: boolean;
  onOpen: (open: boolean) => void;
}): JSX.Element | null {
  const store = useListingStore();
  const { photos } = usePresenters();
  const options = which === 'camera' ? store.cameraModelOptions : store.lensModelOptions;
  const enabled = which === 'camera' ? store.enabledCameraModels : store.enabledLensModels;
  const selected = (which === 'camera' ? store.filters.cameraModels : store.filters.lensModels) ?? [];
  // A library whose files carry no such header has nothing to offer, and an empty
  // submenu is worse than no row.
  if (options.length === 0) return null;

  return (
    <Popover.Root open={open} onOpenChange={onOpen}>
      {/* Hover as well as press: the row reads as a submenu, and the panel around it is a
          popover, which has no submenu of its own to borrow the behaviour from. */}
      <Popover.Trigger {...stylex.props(menuStyles.item, styles.submenu, focusRing.ring)} openOnHover>
        {icon}
        {label}
        {/* What is ticked out of sight, so the panel says a list is narrowed without it
            being opened. */}
        {selected.length > 0 && <span {...stylex.props(menuStyles.badge)}>{selected.length}</span>}
        <ChevronRight size={ICON} {...stylex.props(styles.caret, selected.length === 0 && styles.caretAlone)} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner {...stylex.props(menuStyles.positioner)} side="right" align="start" sideOffset={4}>
          <Popover.Popup {...stylex.props(menuStyles.popup, styles.models)} aria-label={label}>
            {options.map((model) => (
              <label key={model} {...stylex.props(menuStyles.item, styles.check)}>
                <input
                  type="checkbox"
                  checked={selected.includes(model)}
                  disabled={!enabled.has(model)}
                  onChange={(event) => void photos.toggleModel(which, model, event.target.checked)}
                />
                {model}
              </label>
            ))}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});

/**
 * Every question about the collection behind one button: the verdict and rating sets, the
 * filename, and the range of days.
 *
 * A popover rather than a menu, which is what the tick list alone would have been. A menu
 * focuses the first tabbable thing it holds and reads printable keys as typeahead, so a
 * search box in one is a box that cannot be typed into and a set of items that cannot be
 * reached (§18.5 makes the same point about a slider).
 */
export const GridFilterMenu = observer(function GridFilterMenu(): JSX.Element {
  const store = useListingStore();
  const { photos } = usePresenters();
  const f = store.filters;
  const on = customKeys(f);
  const count = store.activeFilterCount;
  const hasModels = store.cameraModelOptions.length > 0 || store.lensModelOptions.length > 0;
  const [openList, setOpenList] = useState<'camera' | 'lens' | null>(null);

  return (
    <PopoverButton
      active={count > 0}
      iconOnly
      label={count > 0 ? GridControlsStrings.filtersWithCount(count) : GridControlsStrings.filters()}
      trigger={<Filter size={ICON} />}
      badge={count > 0 ? count : undefined}
    >
      <div {...stylex.props(styles.filters)}>
        <GridSearchBox />
        <Sections>
          <Section label={GridControlsStrings.sectionTriageStatus()}>
            {CUSTOM.map((option) => (
              <label key={option.value} {...stylex.props(menuStyles.item, styles.check)}>
                <input
                  type="checkbox"
                  checked={on.includes(option.value)}
                  onChange={(event) => {
                    const next = event.target.checked ? [...on, option.value] : on.filter((k) => k !== option.value);
                    void photos.setFilters(withCustom(f, next));
                  }}
                />
                {option.icon}
                {option.label}
              </label>
            ))}
          </Section>
          {/* A library whose files name no body or lens has neither row, and a heading over
              nothing is a section the panel says it has and does not. */}
          {hasModels && (
            <Section label={GridControlsStrings.sectionCamera()}>
              <ModelFilter
                which="camera"
                label={GridControlsStrings.filterCameraBody()}
                icon={<Camera size={ICON} />}
                open={openList === 'camera'}
                onOpen={(open) => setOpenList((current) => openedList('camera', open, current))}
              />
              <ModelFilter
                which="lens"
                label={GridControlsStrings.filterLens()}
                icon={<Aperture size={ICON} />}
                open={openList === 'lens'}
                onOpen={(open) => setOpenList((current) => openedList('lens', open, current))}
              />
            </Section>
          )}
          <Section label={GridControlsStrings.sectionShotDate()}>
            <GridDateRangeFilter />
          </Section>
        </Sections>
        <div {...stylex.props(styles.foot)}>
          <Button variant="ghost" disabled={count === 0} onClick={() => void photos.resetFilters()}>
            {GridControlsStrings.resetFilters()}
          </Button>
        </div>
      </div>
    </PopoverButton>
  );
});
