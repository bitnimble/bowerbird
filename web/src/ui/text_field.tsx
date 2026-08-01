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
  invalid = false,
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
  /** Marks the box as holding an answer that cannot be submitted. */
  invalid?: boolean;
}): JSX.Element {
  return (
    <span className={`ui-input${grow ? ' ui-input--grow' : ''}${invalid ? ' ui-input--invalid' : ''}`}>
      {icon}
      <Input
        value={value}
        aria-label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onValueChange={onChange}
      />
    </span>
  );
}
