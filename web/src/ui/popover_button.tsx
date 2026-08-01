import { Popover } from '@base-ui-components/react/popover';
import type { ReactNode } from 'react';

export function PopoverButton({
  trigger,
  active = false,
  children,
}: {
  trigger: ReactNode;
  active?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <Popover.Root>
      <Popover.Trigger className="ui-btn ui-btn--default" aria-pressed={active}>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner className="ui-positioner" sideOffset={4}>
          <Popover.Popup className="ui-popup ui-popup--pad">{children}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
