import { Input } from '@base-ui-components/react/input';
import type { ReactNode } from 'react';

export function TextField({
  value,
  onChange,
  placeholder,
  label,
  icon,
  autoFocus,
  onBlur,
  onKeyDown,
  grow = false,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  icon?: ReactNode;
  autoFocus?: boolean;
  onBlur?: () => void;
  onKeyDown?: (event: React.KeyboardEvent) => void;
  grow?: boolean;
  disabled?: boolean;
}): JSX.Element {
  return (
    <span className={`ui-input${grow ? ' ui-input--grow' : ''}`}>
      {icon}
      <Input
        value={value}
        aria-label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onValueChange={onChange}
      />
    </span>
  );
}
