import * as stylex from '@stylexjs/stylex';
import { createContext, useContext, useId, type ReactNode } from 'react';
import { Text } from './text';
import { color } from './tokens.stylex';

const styles = stylex.create({
  panel: {
    backgroundColor: color.slateSoft,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: '6px',
    paddingTop: 0,
    paddingInline: '10px',
    paddingBottom: '8px',
    marginBottom: '10px',
  },
  flush: {
    paddingBottom: 0,
  },
  bare: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    padding: 0,
    margin: 0,
  },
  title: {
    display: 'block',
    marginTop: '6px',
  },
  titleBare: {
    marginTop: 0,
  },
});

/** True inside a popup, which is already the box a panel would draw. */
export const PanelsInPopup = createContext(false);

/** A raised box of related rows, under a small caption. */
export function Panel({
  title,
  flush = false,
  style,
  titleStyle,
  children,
}: {
  title?: ReactNode;
  titleStyle?: stylex.StyleXStyles;
  /**
   * For a panel ending in a row that holds the space under itself: the panel's own would land
   * under the last row only, leaving the column sitting higher in its box than it does.
   */
  flush?: boolean;
  style?: stylex.StyleXStyles;
  children: ReactNode;
}): JSX.Element {
  const bare = useContext(PanelsInPopup);
  const titleId = useId();
  return (
    <div
      {...stylex.props(styles.panel, flush && styles.flush, bare && styles.bare, style)}
      role="group"
      aria-labelledby={title == null ? undefined : titleId}
    >
      {title != null && (
        <PanelTitle id={titleId} style={titleStyle}>
          {title}
        </PanelTitle>
      )}
      {children}
    </div>
  );
}

export function PanelTitle({
  id,
  style,
  children,
}: {
  id?: string;
  style?: stylex.StyleXStyles;
  children: ReactNode;
}): JSX.Element {
  const bare = useContext(PanelsInPopup);
  return (
    <Text
      variant="label"
      as="div"
      id={id}
      style={[styles.title, bare && styles.titleBare, style]}
    >
      {children}
    </Text>
  );
}
