import * as stylex from '@stylexjs/stylex';
import { PanelLeftOpen } from 'lucide-react';
import { createContext, useContext, type ReactNode } from 'react';
import { Button } from './button';
import { HeadingInRow } from './heading';
import { ICON } from './icon';
import { PageStrings } from './page.strings';
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
  head: {
    marginBottom: '8px',
  },
});

/** Shows the sidebar, or null while it is already shown. */
export const ShowSidebar = createContext<(() => void) | null>(null);

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

/** The first item of a page's first row. */
export function ShowSidebarButton(): JSX.Element | null {
  const show = useContext(ShowSidebar);
  if (show == null) return null;
  return (
    <Button iconOnly aria-label={PageStrings.showSidebar()} aria-expanded={false} onClick={show}>
      <PanelLeftOpen size={ICON} />
    </Button>
  );
}

/** A page's title with the actions that belong to it on the same line. */
export function PageHead({
  withSidebarButton = false,
  children,
}: {
  withSidebarButton?: boolean;
  children?: ReactNode;
}): JSX.Element {
  return (
    <Row style={styles.head}>
      {withSidebarButton && <ShowSidebarButton />}
      <HeadingInRow.Provider value>{children}</HeadingInRow.Provider>
    </Row>
  );
}
