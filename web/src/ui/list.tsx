import * as stylex from '@stylexjs/stylex';
import { createContext, useContext, type ReactNode } from 'react';
import { Text } from './text';
import { color } from './tokens.stylex';

export const listStyles = stylex.create({
  list: {
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: '6px',
    overflow: 'hidden',
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    paddingBlock: '7px',
    paddingInline: '10px',
    borderBottomWidth: { default: '1px', ':last-child': 0 },
    borderBottomStyle: 'solid',
    borderBottomColor: color.slate,
    backgroundColor: color.slateSoft,
  },
  // Always present and never deletable, so it reads as the surface the rest sit on.
  root: {
    backgroundColor: color.bower,
  },
  body: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
  },
  name: {
    fontWeight: 500,
  },
  meta: {
    marginTop: '4px',
  },
  banner: {
    width: '48px',
    height: '32px',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    backgroundColor: color.bower,
    borderRadius: '3px',
    overflow: 'hidden',
    display: 'block',
  },
  bannerImage: {
    width: '100%',
    height: '100%',
    objectFit: 'cover',
    display: 'block',
  },
  bannerNone: {
    display: 'block',
    width: '100%',
    height: '100%',
    backgroundImage: 'repeating-linear-gradient(45deg, #14171d, #14171d 4px, #191d24 4px, #191d24 8px)',
  },
});

const Announced = createContext(false);

export function List({
  label,
  style,
  children,
}: {
  /** Announces the list and each of its rows, for a list whose every child is a `ListRow`. */
  label?: string;
  style?: stylex.StyleXStyles;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      {...stylex.props(listStyles.list, style)}
      role={label == null ? undefined : 'list'}
      aria-label={label}
    >
      <Announced.Provider value={label != null}>{children}</Announced.Provider>
    </div>
  );
}

export function ListRow({
  root = false,
  style,
  children,
}: {
  /** The row everything else in the list sits under, such as a library's own root. */
  root?: boolean;
  style?: stylex.StyleXStyles;
  children: ReactNode;
}): JSX.Element {
  const announced = useContext(Announced);
  return (
    <div
      {...stylex.props(listStyles.row, root && listStyles.root, style)}
      role={announced ? 'listitem' : undefined}
    >
      {children}
    </div>
  );
}

/** The part of a row that takes the width its banner and actions leave. */
export function ListBody({ children }: { children?: ReactNode }): JSX.Element {
  return <div {...stylex.props(listStyles.body)}>{children}</div>;
}

export function ListName({ children }: { children: ReactNode }): JSX.Element {
  return <span {...stylex.props(listStyles.name)}>{children}</span>;
}

export function ListMeta({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Text variant="mono" as="div" style={listStyles.meta}>
      {children}
    </Text>
  );
}
