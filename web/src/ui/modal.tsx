import { Dialog } from '@base-ui-components/react/dialog';
import * as stylex from '@stylexjs/stylex';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { headingStyles } from './heading';
import { ICON } from './icon';
import { ModalStrings } from './modal.strings';
import { color } from './tokens.stylex';

const styles = stylex.create({
  backdrop: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(6, 8, 11, 0.72)',
    zIndex: 50,
  },
  popup: {
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    backgroundColor: color.slateSoft,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: '8px',
    padding: '16px',
    minWidth: '320px',
    zIndex: 51,
    // A dialog taller than the window would otherwise put its own buttons off-screen, out of reach.
    maxHeight: 'calc(100dvh - 32px)',
    overflowY: 'auto',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '10px',
  },
});

export function Modal({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
        <Dialog.Popup {...stylex.props(styles.popup)}>
          <div {...stylex.props(styles.head)}>
            <Dialog.Title {...stylex.props(headingStyles.base, headingStyles.h2)}>{title}</Dialog.Title>
            <Dialog.Close render={<Button variant="ghost" iconOnly aria-label={ModalStrings.close()} />}>
              <X size={ICON} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
