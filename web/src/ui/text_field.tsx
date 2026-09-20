import { Input } from '@base-ui-components/react/input';
import * as stylex from '@stylexjs/stylex';
import { useContext, type ReactNode } from 'react';
import { InField } from './field';
import { fieldStyles } from './field_styles';
import { color, size } from './tokens.stylex';

const styles = stylex.create({
  wrap: {
    height: size.controlH,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    paddingBlock: 0,
    paddingInline: '9px',
    color: color.boneDim,
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    minWidth: 0,
  },
  grow: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '200px',
  },
  growInField: {
    width: '100%',
  },
  // The bed is the wrapper's, so the icon and the suffix sit inside it.
  input: {
    backgroundColor: 'transparent',
    borderWidth: 0,
    borderRadius: size.radius,
    outline: 'none',
    minWidth: 0,
    width: '100%',
    fontSize: size.controlText,
    color: color.bone,
    '::placeholder': { color: '#5c626e' },
  },
});

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
  type = 'text',
  min,
  max,
  step,
  suffix,
  describedBy,
  style,
  inputStyle,
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
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  /** The id of text saying what this field does, for a reader who only hears the label. */
  describedBy?: string;
  /** On the bed around the input. */
  style?: stylex.StyleXStyles;
  inputStyle?: stylex.StyleXStyles;
}): JSX.Element {
  const inField = useContext(InField);
  return (
    <span
      {...stylex.props(
        fieldStyles.bed,
        styles.wrap,
        grow && (inField ? styles.growInField : styles.grow),
        style,
      )}
    >
      {icon}
      <Input
        {...stylex.props(styles.input, fieldStyles.autofill, inputStyle)}
        type={type}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={suffix == null ? label : `${label} (${suffix})`}
        aria-describedby={describedBy}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onValueChange={onChange}
      />
      {suffix != null && <span aria-hidden="true">{suffix}</span>}
    </span>
  );
}
