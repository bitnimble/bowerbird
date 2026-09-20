import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { X } from 'lucide-react';
import { usePresenters, useToastsStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import { Text } from '../../ui/text';
import { color } from '../../ui/tokens.stylex';
import { ToastsStrings } from './toasts.strings';

const styles = stylex.create({
  toasts: {
    position: 'fixed',
    right: '16px',
    bottom: '16px',
    zIndex: 40,
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  toast: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    backgroundColor: color.slateSoft,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderLeftWidth: '2px',
    borderLeftColor: color.satin,
    borderRadius: '5px',
    paddingBlock: '8px',
    paddingInline: '10px',
    minWidth: '300px',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
  },
  error: {
    borderLeftColor: color.rose,
    color: '#f0a9a3',
  },
  // Takes the slack the min-width leaves, so the dismiss stays pinned to the right edge.
  message: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  detail: {
    marginTop: '4px',
    wordBreak: 'break-word',
  },
  progress: {
    display: 'block',
    marginTop: '6px',
    height: '3px',
    borderRadius: '2px',
    backgroundColor: color.slate,
    overflow: 'hidden',
  },
  fill: {
    display: 'block',
    height: '100%',
    backgroundColor: color.satin,
    // Arrives in steps a strip apart, which without this reads as a jerk per strip.
    transitionProperty: 'width',
    transitionDuration: '200ms',
    transitionTimingFunction: 'linear',
  },
});

export const Toasts = observer(function Toasts(): JSX.Element | null {
  const store = useToastsStore();
  const { toasts } = usePresenters();
  if (store.toasts.length === 0) return null;

  return (
    <div {...stylex.props(styles.toasts)} role="status" aria-live="polite">
      {store.toasts.map((toast) => (
        <div {...stylex.props(styles.toast, toast.tone === 'error' && styles.error)} key={toast.id}>
          <span {...stylex.props(styles.message)}>
            {toast.message}
            {toast.detail != null && (
              <Text variant="mono" as="div" style={styles.detail}>
                {toast.detail}
              </Text>
            )}
            {toast.progress != null && (
              <span
                {...stylex.props(styles.progress)}
                role="progressbar"
                aria-valuenow={Math.round(toast.progress * 100)}
                aria-label={toast.message}
                // Out of the toast's live region: this moves several times a second, and a reader
                // that announced every step would talk over everything else on the page.
                aria-live="off"
              >
                <span {...stylex.props(styles.fill)} style={{ width: `${toast.progress * 100}%` }} />
              </span>
            )}
          </span>
          {toast.undo != null && <Button onClick={() => void toasts.runUndo(toast.id)}>{toast.undoLabel}</Button>}
          <Button variant="ghost" iconOnly aria-label={ToastsStrings.dismiss()} onClick={() => toasts.dismiss(toast.id)}>
            <X size={ICON} />
          </Button>
        </div>
      ))}
    </div>
  );
});
