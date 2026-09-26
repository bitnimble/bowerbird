import * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import { color } from '../../web/src/ui/tokens.stylex';
import SpeedCopy from './copy/speed.mdx';
import { Paragraph } from './prose';

const WIDE = '@media (min-width: 960px)';

const styles = stylex.create({
  band: {
    fontSize: { default: '17px', [WIDE]: '19px' },
    paddingBlock: { default: '40px', [WIDE]: '64px' },
    borderTopWidth: '1px',
    borderBottomWidth: '1px',
    borderTopStyle: 'solid',
    borderBottomStyle: 'solid',
    borderTopColor: color.slate,
    borderBottomColor: color.slate,
  },
  paragraph: {
    lineHeight: 1.55,
  },
});

export function Speed(): JSX.Element {
  return (
    <div {...stylex.props(styles.band)}>
      <SpeedCopy components={{ p: LoudParagraph }} />
    </div>
  );
}

function LoudParagraph({ children }: { children?: ReactNode }): JSX.Element {
  return <Paragraph style={styles.paragraph}>{children}</Paragraph>;
}
