import * as stylex from '@stylexjs/stylex';
import { color } from './tokens.stylex';

const styles = stylex.create({
  bar: {
    appearance: 'none',
    display: 'block',
    width: '100%',
    height: '3px',
    borderWidth: 0,
    borderRadius: '2px',
    backgroundColor: color.slate,
    overflow: 'hidden',
    '::-webkit-progress-bar': { backgroundColor: color.slate },
    '::-webkit-progress-value': { backgroundColor: color.satin },
    '::-moz-progress-bar': { backgroundColor: color.satin },
  },
});

/** How far through something the app is doing for the reader. Named, because a page can hold several. */
export function ProgressBar({ label, value, max }: { label: string; value: number; max: number }): JSX.Element {
  return <progress {...stylex.props(styles.bar)} aria-label={label} value={value} max={max} />;
}
