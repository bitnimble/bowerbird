import * as stylex from '@stylexjs/stylex';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ButtonHint, type StyleArg } from './button';

const styles = stylex.create({
  slot: {
    position: 'relative',
    display: 'flex',
    justifyContent: 'center',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    overflow: 'hidden',
  },
  least: (width: number) => ({ minWidth: `${width}px` }),
  ghost: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 'max-content',
    visibility: 'hidden',
    pointerEvents: 'none',
  },
});

export type LabelFitItem = { key: string; icon: ReactNode; label: string; hint?: string };

/**
 * A row of icon buttons, labelled where there is room for every label and otherwise labelled
 * only at `selected`. Takes the free width of a flex row, centring the buttons in it.
 */
export function LabelFit({
  items,
  selected,
  rowStyle,
  itemStyle,
  style,
  children,
}: {
  items: readonly LabelFitItem[];
  selected: string | null;
  /** The real row's metrics, for the copies measured out of sight. */
  rowStyle: StyleArg;
  itemStyle: (labelled: boolean, selected: boolean) => StyleArg;
  style?: stylex.StyleXStyles;
  children: (labelled: (key: string) => boolean) => ReactNode;
}): JSX.Element {
  const slot = useRef<HTMLDivElement>(null);
  const every = useRef<HTMLDivElement>(null);
  const least = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState({ slot: 0, every: 0, least: 0 });

  useLayoutEffect(() => {
    // Once at mount: the observer's first report lands after paint, flashing icon-only rows.
    setWidths({
      slot: slot.current?.clientWidth ?? 0,
      every: every.current?.offsetWidth ?? 0,
      least: least.current?.offsetWidth ?? 0,
    });
    const observer = new ResizeObserver((entries) => {
      setWidths((was) => {
        const next = { ...was };
        for (const { target, contentRect } of entries) {
          if (target === slot.current) next.slot = contentRect.width;
          else if (target === every.current) next.every = contentRect.width;
          else if (target === least.current) next.least = contentRect.width;
        }
        const same = next.slot === was.slot && next.every === was.every && next.least === was.least;
        return same ? was : next;
      });
    });
    for (const element of [slot.current, every.current, least.current]) {
      if (element != null) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  const fits = widths.every > 0 && widths.every <= widths.slot;
  const ghost = (labelled: (key: string) => boolean): JSX.Element => (
    <div {...stylex.props(rowStyle)}>
      {items.map(({ key, icon, label, hint }) => (
        <span key={key} {...stylex.props(itemStyle(labelled(key), key === selected))}>
          {icon}
          {labelled(key) && label}
          {labelled(key) && hint != null && <ButtonHint>{hint}</ButtonHint>}
        </span>
      ))}
    </div>
  );

  return (
    <div ref={slot} {...stylex.props(styles.slot, styles.least(widths.least), style)}>
      {children(fits ? () => true : (key) => key === selected)}
      <div ref={every} aria-hidden {...{ inert: '' }} {...stylex.props(styles.ghost)}>
        {ghost(() => true)}
      </div>
      <div ref={least} aria-hidden {...{ inert: '' }} {...stylex.props(styles.ghost)}>
        {ghost((key) => key === selected)}
      </div>
    </div>
  );
}
