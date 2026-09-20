import * as stylex from '@stylexjs/stylex';
import { color } from '../../../ui/tokens.stylex';

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });

const styles = stylex.create({
  spinner: {
    width: '26px',
    height: '26px',
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderTopColor: color.glass,
    borderRadius: '50%',
    animationName: spin,
    animationDuration: '0.8s',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  small: {
    width: '12px',
    height: '12px',
  },
});

export function StageSpinner({ small = false }: { small?: boolean }): JSX.Element {
  return <div {...stylex.props(styles.spinner, small && styles.small)} />;
}
