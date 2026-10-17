import { Dialog } from '@base-ui-components/react/dialog';
import * as stylex from '@stylexjs/stylex';
import { X } from 'lucide-react';
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
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
    // The backdrop's, so order decides: a dialog opened from inside another dims that one too.
    zIndex: 50,
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
  body: {
    display: 'contents',
  },
});

const CONTROL =
  'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onOpenChange,
  title,
  initialFocus,
  step,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * Which step a wizard is on. A change moves the focus to the new step's first control, since
   * the one that held it went with the old step.
   */
  step?: string;
  children: ReactNode;
}): JSX.Element {
  const body = useRef<HTMLDivElement>(null);
  const shownStep = useRef(step);
  // Layout, inside the commit that removed the old step: after it, Base UI finds the focus lost
  // and takes it to the popup.
  useLayoutEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    body.current?.querySelector<HTMLElement>(CONTROL)?.focus();
  }, [step]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
        <Dialog.Popup {...stylex.props(styles.popup)} initialFocus={initialFocus}>
          <div {...stylex.props(styles.head)}>
            <Dialog.Title {...stylex.props(headingStyles.base, headingStyles.h2)}>
              {title}
            </Dialog.Title>
            <Dialog.Close
              render={<Button variant="ghost" iconOnly aria-label={ModalStrings.close()} />}
            >
              <X size={ICON} />
            </Dialog.Close>
          </div>
          <div ref={body} {...stylex.props(styles.body)}>
            {children}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
