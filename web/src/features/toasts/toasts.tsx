import { observer } from 'mobx-react-lite';
import { X } from 'lucide-react';
import { usePresenters, useToastsStore } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import { Text } from '../../ui/text';

export const Toasts = observer(function Toasts(): JSX.Element | null {
  const store = useToastsStore();
  const { toasts } = usePresenters();
  if (store.toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {store.toasts.map((toast) => (
        <div className={`toast${toast.tone == null ? '' : ` toast--${toast.tone}`}`} key={toast.id}>
          <span>
            {toast.message}
            {toast.detail != null && (
              <Text variant="mono" as="div" className="toast__detail">
                {toast.detail}
              </Text>
            )}
          </span>
          {toast.undo != null && <Button onClick={() => void toasts.runUndo(toast.id)}>{toast.undoLabel}</Button>}
          <Button variant="ghost" iconOnly aria-label="Dismiss" onClick={() => toasts.dismiss(toast.id)}>
            <X size={ICON} />
          </Button>
        </div>
      ))}
    </div>
  );
});
