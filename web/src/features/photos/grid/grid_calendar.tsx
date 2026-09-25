import * as stylex from '@stylexjs/stylex';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useRef, type CSSProperties } from 'react';
import {
  DayPicker,
  getDefaultClassNames,
  useDayPicker,
  type ClassNames,
  type DateRange,
  type DayButtonProps,
  type MonthCaptionProps,
} from 'react-day-picker';
import { useListingStore, usePresenters } from '../../../app/stores_context';
import { Button } from '../../../ui/button';
import { focusRing } from '../../../ui/focus_ring';
import { ICON } from '../../../ui/icon';
import { Select } from '../../../ui/select';
import { color, size } from '../../../ui/tokens.stylex';
import { calendarSize } from './calendar.stylex';
import { GridControlsStrings } from './grid_controls.strings';
import { styles } from './grid_controls.stylex';

const RDP = getDefaultClassNames();

const CALENDAR_CLASSES: Partial<ClassNames> = {
  weekday: `${RDP.weekday} ${stylex.props(styles.weekday).className}`,
  month_caption: `${RDP.month_caption} ${stylex.props(styles.monthCaption).className}`,
  day_button: `${RDP.day_button} ${stylex.props(styles.dayButton).className}`,
};

// Inline, not a StyleX class: a custom property gets no specificity boost, so a class ties with
// react-day-picker's own `.rdp-root` and loses whenever its sheet loads later, as it does in dev.
const CALENDAR_VARS = {
  '--rdp-accent-color': color.satin,
  '--rdp-accent-background-color': '#1f2a3f',
  '--rdp-today-color': color.glass,
  '--rdp-day-height': calendarSize.day,
  '--rdp-day-width': calendarSize.day,
  '--rdp-day_button-height': calendarSize.dayButton,
  '--rdp-day_button-width': calendarSize.dayButton,
  '--rdp-day_button-border-radius': size.radius,
  '--rdp-range_middle-background-color': '#1a2333',
  '--rdp-range_middle-color': color.bone,
} as CSSProperties;

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

const AnyDateButton = observer(function AnyDateButton(): JSX.Element {
  const store = useListingStore();
  const { photos } = usePresenters();
  const f = store.filters;

  return (
    <Button
      variant="ghost"
      iconOnly
      // The month arrows are a glyph apiece and the row is as wide as the calendar; a
      // word here would sit over the month's name.
      aria-label={GridControlsStrings.anyDate()}
      disabled={f.takenFrom == null && f.takenTo == null}
      onClick={() => void photos.setFilters({ ...f, takenFrom: undefined, takenTo: undefined })}
    >
      <RotateCcw size={ICON} />
    </Button>
  );
});

/**
 * The calendar's month arrows, with what clears the range beside them. Drawn in the caption
 * rather than through `components.Nav`, which react-day-picker floats at the top right of
 * the whole calendar - a corner the two selects do not reach.
 */
function CalendarNav(): JSX.Element {
  const { goToMonth, previousMonth, nextMonth } = useDayPicker();
  return (
    <nav {...stylex.props(styles.nav)}>
      <AnyDateButton />
      <button
        type="button"
        className={`${RDP.button_previous} ${stylex.props(styles.navButton, focusRing.ring).className}`}
        aria-label={GridControlsStrings.previousMonth()}
        disabled={previousMonth == null}
        onClick={() => previousMonth != null && goToMonth(previousMonth)}
      >
        <ChevronLeft size={ICON} />
      </button>
      <button
        type="button"
        className={`${RDP.button_next} ${stylex.props(styles.navButton, focusRing.ring).className}`}
        aria-label={GridControlsStrings.nextMonth()}
        disabled={nextMonth == null}
        onClick={() => nextMonth != null && goToMonth(nextMonth)}
      >
        <ChevronRight size={ICON} />
      </button>
    </nav>
  );
}

/** What the quietest day's dot is against the busiest one's, in opacity and in size. */
const DOT_FAINTEST = 0.45;
const DOT_SMALLEST = 0.5;

const DayDot = observer(function DayDot({ date, picked }: { date: Date; picked: boolean }): JSX.Element | null {
  const store = useListingStore();
  const density = store.dayDensity.get(isoDay(date));
  if (density == null) return null;
  return (
    <span
      {...stylex.props(styles.dayDot, picked && styles.dayDotPicked)}
      aria-hidden
      style={{
        opacity: DOT_FAINTEST + (1 - DOT_FAINTEST) * density,
        // Scaled rather than sized: a fractional width and a fractional height round
        // independently, and a 3.4px "circle" comes out an ellipse.
        transform: `translateX(-50%) scale(${DOT_SMALLEST + (1 - DOT_SMALLEST) * density})`,
      }}
    />
  );
});

/**
 * A day, with how much was shot on it under the number.
 *
 * Not an `observer` itself, for the reason `CalendarNav` is not: react-day-picker types a
 * day as returning an element. The focus effect is the default component's, which this
 * replaces rather than wraps - without it the arrow keys move the highlight and not the
 * caret.
 */
function CalendarDayButton({ day, modifiers, children, ...buttonProps }: DayButtonProps): JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);
  return (
    <button ref={ref} {...buttonProps}>
      {children}
      <DayDot date={day.date} picked={modifiers.selected === true || modifiers.range_middle === true} />
    </button>
  );
}

const MONTH_NAMES = Array.from({ length: 12 }, (_, month) =>
  new Intl.DateTimeFormat(undefined, { month: 'long' }).format(new Date(2000, month, 1)),
);

/**
 * The month and the year as two of the app's own selects.
 *
 * react-day-picker's own dropdown layout is a native `<select>` laid invisibly over the
 * caption, which neither matches the chrome around it nor answers a click in a popover.
 * `goToMonth` clamps to the collection's ends, so the lists only offer months and years
 * it actually spans.
 */
const CaptionSelects = observer(function CaptionSelects({ month }: { month: Date }): JSX.Element {
  const store = useListingStore();
  const { goToMonth } = useDayPicker();
  const first = parseDay(store.firstPhotoDay) ?? month;
  const last = parseDay(store.lastPhotoDay) ?? month;
  const year = month.getFullYear();
  const from = year === first.getFullYear() ? first.getMonth() : 0;
  const to = year === last.getFullYear() ? last.getMonth() : 11;

  return (
    <div {...stylex.props(styles.caption)}>
      <Select
        style={styles.month}
        label={GridControlsStrings.calendarMonth()}
        value={String(month.getMonth())}
        options={MONTH_NAMES.slice(from, to + 1).map((name, index) => ({ value: String(from + index), label: name }))}
        onChange={(picked) => goToMonth(new Date(year, Number(picked), 1))}
      />
      <Select
        style={styles.year}
        label={GridControlsStrings.calendarYear()}
        value={String(year)}
        options={Array.from({ length: last.getFullYear() - first.getFullYear() + 1 }, (_, index) => {
          const value = String(first.getFullYear() + index);
          return { value, label: value };
        })}
        onChange={(picked) => goToMonth(new Date(Number(picked), month.getMonth(), 1))}
      />
    </div>
  );
});

/**
 * Not an `observer`: react-day-picker types a caption as returning an element, where an
 * observer returns the wider ReactNode.
 */
function CalendarCaption({ calendarMonth, displayIndex: _displayIndex, ...captionProps }: MonthCaptionProps): JSX.Element {
  return (
    <div {...captionProps}>
      <CalendarNav />
      <CaptionSelects month={calendarMonth.date} />
    </div>
  );
}

export const GridDateRangeFilter = observer(function GridDateRangeFilter(): JSX.Element {
  const store = useListingStore();
  const { photos } = usePresenters();
  const from = store.filters.takenFrom;
  const to = store.filters.takenTo;
  const selected: DateRange | undefined = from == null && to == null ? undefined : { from: parseDay(from), to: parseDay(to) };
  // The month a picked range starts in, else the last one the collection holds anything
  // in. Keyed on it because react-day-picker reads an opening month once: a collection
  // whose days land after the panel is open would otherwise stay on this month.
  const opening = from ?? store.lastPhotoDay;

  return (
    <DayPicker
      key={opening}
      mode="range"
      selected={selected}
      defaultMonth={parseDay(opening)}
      // The months the collection spans, which is what the caption's two selects offer
      // and what the arrows stop at.
      startMonth={parseDay(store.firstPhotoDay)}
      endMonth={parseDay(store.lastPhotoDay)}
      hideNavigation
      className={stylex.props(styles.calendar).className}
      style={CALENDAR_VARS}
      classNames={CALENDAR_CLASSES}
      components={{ DayButton: CalendarDayButton, MonthCaption: CalendarCaption }}
      onSelect={(range) =>
        void photos.setFilters({
          ...store.filters,
          takenFrom: range?.from == null ? undefined : isoDay(range.from),
          takenTo: range?.to == null ? undefined : isoDay(range.to),
        })
      }
    />
  );
});
