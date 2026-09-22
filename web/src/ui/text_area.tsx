import * as stylex from '@stylexjs/stylex';
import { fieldStyles } from './field_styles';
import { focusRing } from './focus_ring';
import { size } from './tokens.stylex';

const styles = stylex.create({
  area: {
    width: '100%',
    minHeight: '60px',
    resize: 'vertical',
    paddingBlock: '7px',
    paddingInline: '9px',
    fontSize: size.controlText,
  },
});

export function TextArea({
  value,
  onChange,
  onBlur,
  placeholder,
  label,
  required = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  label: string;
  required?: boolean;
}): JSX.Element {
  return (
    <textarea
      {...stylex.props(fieldStyles.bed, fieldStyles.autofill, styles.area, focusRing.ring)}
      aria-label={label}
      required={required}
      placeholder={placeholder}
      value={value}
      onBlur={onBlur}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
