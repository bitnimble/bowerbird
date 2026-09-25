import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { focusRing } from './focus_ring';
import { color } from './tokens.stylex';
import { Tooltip } from './tooltip';

const FINE = '@media (pointer: fine)';

const styles = stylex.create({
  link: {
    // A touchscreen has no hover to discover a link with, so it is underlined at rest there.
    textDecorationLine: {
      default: 'underline',
      [FINE]: { default: 'none', ':hover': 'underline', ':focus-visible': 'underline' },
    },
    textDecorationColor: { default: color.boneDim, ':hover': color.satin, ':focus-visible': color.satin },
    textUnderlineOffset: '2px',
  },
});

/**
 * A link that reads as one: text inside a sentence or a field, rather than a whole row, tile
 * or sidebar entry that happens to navigate.
 */
export function TextLink({ to, tooltip, children }: { to: string; tooltip?: string; children: ReactNode }): JSX.Element {
  return (
    <Tooltip label={tooltip}>
      <Link {...stylex.props(styles.link, focusRing.ring)} to={to}>
        {children}
      </Link>
    </Tooltip>
  );
}
