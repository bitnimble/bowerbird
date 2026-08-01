import { Dialog } from '@base-ui-components/react/dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { ICON } from './icon';

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
        <Dialog.Backdrop className="ui-backdrop" />
        <Dialog.Popup className="ui-modal">
          <div className="ui-modal__head">
            <Dialog.Title className="ui-h ui-h--2">{title}</Dialog.Title>
            <Dialog.Close render={<Button variant="ghost" iconOnly aria-label="Close" />}>
              <X size={ICON} />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
