import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { usePrecompileStore } from '../../app/stores_context';
import { Heading } from '../../ui/heading';
import { ProgressBar } from '../../ui/progress_bar';
import { Text } from '../../ui/text';
import { PrecompilePageStrings } from './precompile_page.strings';

const styles = stylex.create({
  centred: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '12px',
    position: 'relative',
  },
  footnote: {
    position: 'absolute',
    insetInline: 0,
    bottom: '32px',
    textAlign: 'center',
  },
  progress: {
    width: '280px',
  },
});

export const PrecompilePage = observer(function PrecompilePage(): JSX.Element {
  const { compiled, toCompile } = usePrecompileStore();
  return (
    <div {...stylex.props(styles.centred)}>
      <Heading>{PrecompilePageStrings.preparing()}</Heading>
      <Text variant="muted" as="p" style={styles.footnote}>
        {PrecompilePageStrings.precompiling()}
      </Text>
      <ProgressBar
        label={PrecompilePageStrings.preparing()}
        value={compiled}
        // `<progress>` needs max > 0; toCompile is 0 until counted.
        max={Math.max(toCompile, 1)}
        style={styles.progress}
      />
    </div>
  );
});
