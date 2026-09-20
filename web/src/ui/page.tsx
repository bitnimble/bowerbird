import * as stylex from '@stylexjs/stylex';
import { createContext, useContext, type ReactNode } from 'react';
import { HeadingInRow } from './heading';
import { Row } from './row';
import { size } from './tokens.stylex';

const styles = stylex.create({
  page: {
    paddingTop: '12px',
    paddingInline: size.padX,
    paddingBottom: size.padB,
  },
  fill: {
    height: '100%',
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column',
    // The bottom inset belongs to whatever scrolls inside, or the last row is cut off above a strip
    // of window no photograph can reach.
    paddingBottom: 0,
  },
  lead: {
    display: 'inline-block',
    width: `calc(${size.controlH} + 8px)`,
  },
  head: {
    marginBottom: '8px',
  },
});

/** True while the sidebar's show button floats over the top-left corner of the page. */
export const PageLeadRoom = createContext(false);

export function Page({
  fill = false,
  style,
  children,
}: {
  /** For a page that owns the height it was given, whose content scrolls inside it. */
  fill?: boolean;
  style?: stylex.StyleXStyles;
  children: ReactNode;
}): JSX.Element {
  return <div {...stylex.props(styles.page, fill && styles.fill, style)}>{children}</div>;
}

/**
 * Room for the sidebar's show button, as the first item of a page's first row: padding on the
 * page would keep a button-wide gutter beside everything under it too.
 */
export function PageLead(): JSX.Element | null {
  return useContext(PageLeadRoom) ? <span {...stylex.props(styles.lead)} aria-hidden="true" /> : null;
}

/** A page's title with the actions that belong to it on the same line. */
export function PageHead({ lead = false, children }: { lead?: boolean; children: ReactNode }): JSX.Element {
  return (
    <Row style={styles.head}>
      {lead && <PageLead />}
      <HeadingInRow.Provider value>{children}</HeadingInRow.Provider>
    </Row>
  );
}
