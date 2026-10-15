import * as stylex from '@stylexjs/stylex';
import type { KeyboardEvent, ReactNode } from 'react';
import { Text } from '../../../web/src/ui/text';
import { color } from '../../../web/src/ui/tokens.stylex';

const styles = stylex.create({
  demo: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '12px',
    backgroundColor: color.bower,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: '6px',
  },
  bar: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
  },
  warning: {
    margin: 0,
    lineHeight: 1.6,
  },
});

export function Demo({
  onKeyDown,
  children,
}: {
  onKeyDown?: (event: KeyboardEvent) => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div {...stylex.props(styles.demo)} onKeyDown={onKeyDown}>
      {children}
    </div>
  );
}

export function DemoBar({ children }: { children: ReactNode }): JSX.Element {
  return <div {...stylex.props(styles.bar)}>{children}</div>;
}

export function DemoWarning({ children }: { children: ReactNode }): JSX.Element {
  return (
    <Text as="p" variant="mono" tone="warning" style={styles.warning}>
      {children}
    </Text>
  );
}
