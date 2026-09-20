import * as stylex from '@stylexjs/stylex';
import { createContext, useContext, type ReactNode } from 'react';
import { color } from './tokens.stylex';

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
    width: 'min(520px, 78vw)',
  },
  wide: {
    // Less the modal's own padding and border, or on a phone the modal hangs off both edges.
    width: 'min(820px, calc(100vw - 50px))',
  },
  fixed: {
    height: 'min(calc(100dvh - 110px), 720px)',
    overflowY: 'auto',
  },
  capped: {
    maxHeight: 'min(calc(100dvh - 110px), 900px)',
    overflowY: 'auto',
  },
  columns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '12px 20px',
    alignItems: 'start',
  },
  ruled: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    paddingTop: '12px',
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  },
  stuck: {
    position: 'sticky',
    bottom: 0,
    marginTop: 'auto',
    paddingTop: '12px',
    backgroundColor: color.slateSoft,
  },
});

const Scrolls = createContext(false);

/** The contents of a `Modal`: fields over the buttons that act on them. */
export function DialogBody({
  wide = false,
  height,
  children,
}: {
  wide?: boolean;
  /**
   * `fixed` for fields that change what else the dialog asks, so its buttons do not move out from
   * under the pointer; `capped` for steps the reader moves between. Either scrolls inside a
   * ceiling, with the buttons held at its foot.
   */
  height?: 'fixed' | 'capped';
  children: ReactNode;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.body, wide && styles.wide, height != null && styles[height])}>
      <Scrolls.Provider value={height != null}>{children}</Scrolls.Provider>
    </div>
  );
}

export function DialogColumns({ ruled = false, children }: { ruled?: boolean; children: ReactNode }): JSX.Element {
  return <div {...stylex.props(styles.columns, ruled && styles.ruled)}>{children}</div>;
}

export function DialogStack({ children }: { children: ReactNode }): JSX.Element {
  return <div {...stylex.props(styles.stack)}>{children}</div>;
}

export function DialogActions({ children }: { children: ReactNode }): JSX.Element {
  const stuck = useContext(Scrolls);
  return <div {...stylex.props(styles.actions, stuck && styles.stuck)}>{children}</div>;
}
