export function TextArea({
  value,
  onChange,
  onBlur,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  label: string;
}): JSX.Element {
  return (
    <textarea
      className="ui-textarea"
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onBlur={onBlur}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
