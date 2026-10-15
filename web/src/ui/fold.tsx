import * as stylex from '@stylexjs/stylex';
import { forwardRef, useCallback, useRef, useState } from 'react';
import { menuSection, type MenuSection } from './menu_section';
import { Text, textStyles } from './text';
import { size } from './tokens.stylex';

const styles = stylex.create({
  slot: {
    display: 'flex',
    flexWrap: 'wrap',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    height: size.controlH,
    overflow: 'hidden',
    // A lone item never wraps: without this, text with no room overflows instead of wrapping onto the clipped line.
    '::before': {
      content: '""',
      height: '100%',
    },
  },
  text: {
    lineHeight: size.controlH,
    whiteSpace: 'nowrap',
  },
  shrinks: {
    minWidth: '12ch',
    maxWidth: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  // The popup is sized by its widest row, and a path has no word to break at.
  menuText: {
    display: 'block',
    maxWidth: '70vw',
    paddingBlock: '6px',
    paddingInline: '9px',
    overflowWrap: 'anywhere',
  },
});

/** The ref goes on an element whose parent is the box that clips it. */
export function useFolded(): [folded: boolean, ref: (element: Element | null) => void] {
  const [folded, setFolded] = useState(false);
  const observer = useRef<IntersectionObserver | null>(null);
  const ref = useCallback((element: Element | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (element == null) {
      setFolded(false);
      return;
    }
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setFolded(entry.intersectionRatio < 0.5);
      },
      // Not 0: text wrapped onto the clipped line touches the root's edge, which counts as intersecting.
      { root: element.parentElement, threshold: 0.5 },
    );
    observer.current.observe(element);
  }, []);
  return [folded, ref];
}

/** Takes `useFolded`'s ref. */
export const BarText = forwardRef<
  HTMLSpanElement,
  {
    children: string;
    /** Gives up width, ellipsised, down to a few characters before it folds. */
    shrinks?: boolean;
    style?: stylex.StyleXStyles;
  }
>(function BarText({ children, shrinks = false, style }, ref): JSX.Element {
  return (
    <span {...stylex.props(styles.slot, style)}>
      <span ref={ref} {...stylex.props(textStyles.mono, styles.text, shrinks && styles.shrinks)}>
        {children}
      </span>
    </span>
  );
});

export function textSection(text: string): MenuSection {
  return menuSection({
    content: (
      <Text variant="mono" style={styles.menuText}>
        {text}
      </Text>
    ),
  });
}
