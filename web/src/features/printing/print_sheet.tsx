import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { createPortal } from 'react-dom';
import { usePresenters, usePrintDialogStore } from '../../app/stores_context';

const styles = stylex.create({
  sheet: {
    display: { default: 'none', '@media print': 'flex' },
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
    height: '100vh',
  },
  picture: {
    maxWidth: '100%',
    maxHeight: '100vh',
    objectFit: 'contain',
  },
});

/** The photo as Android's print dialog lays the page out, and nothing on screen. */
export const PrintSheet = observer(function PrintSheet(): JSX.Element | null {
  const { sheet } = usePrintDialogStore();
  const { printing } = usePresenters();
  if (sheet == null) return null;
  return createPortal(
    <div {...stylex.props(styles.sheet)}>
      <img
        key={sheet.url}
        {...stylex.props(styles.picture)}
        src={sheet.url}
        alt={sheet.name}
        onLoad={() => void printing.sheetLoaded()}
      />
    </div>,
    document.body,
  );
});
