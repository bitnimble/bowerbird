import { Toggle } from '@base-ui-components/react/toggle';
import type { ReactNode } from 'react';

// On or off, for a control that states what the view *is* rather than doing
// something to it. Same metrics as every other button; pressed, it wears the
// segmented control's own on-state, because they mean the same thing.
export function ToggleButton({
  label,
  icon,
  pressed,
  onChange,
}: {
  label: string;
  icon?: ReactNode;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
}): JSX.Element {
  return (
    <Toggle className="ui-btn ui-btn--toggle" pressed={pressed} onPressedChange={onChange}>
      {icon}
      {label}
    </Toggle>
  );
}
