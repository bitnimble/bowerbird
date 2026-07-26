import { Button as BaseButton } from '@base-ui-components/react/button';
import { Dialog } from '@base-ui-components/react/dialog';
import { Input } from '@base-ui-components/react/input';
import { Menu } from '@base-ui-components/react/menu';
import { Popover } from '@base-ui-components/react/popover';
import { Select as BaseSelect } from '@base-ui-components/react/select';
import { Slider as BaseSlider } from '@base-ui-components/react/slider';
import { Toggle } from '@base-ui-components/react/toggle';
import { ToggleGroup } from '@base-ui-components/react/toggle-group';
import { Check, ChevronDown, X } from 'lucide-react';
import { cloneElement, type ReactElement, type ReactNode } from 'react';

// The whole component vocabulary. Everything on screen is built from these, so
// a control cannot pick its own height, font or icon size: `.ui-btn` carries all
// three and every interactive element in the app wears it.
//
// Variants are deliberately few. A fifth button colour or a fifth text style
// should mean rethinking the screen, not adding a variant here.

export const ICON = 14; // every icon in a control, no exceptions

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';

interface ButtonProps {
  variant?: ButtonVariant;
  iconOnly?: boolean;
  children?: ReactNode;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
  className?: string;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  'aria-current'?: 'page';
  onClick?: (event: React.MouseEvent) => void;
  // Renders the button as something else (a router Link, an anchor) while
  // keeping the metrics and keyboard behaviour.
  render?: ReactElement<Record<string, unknown>>;
}

export function Button({ variant = 'default', iconOnly = false, className, render, ...props }: ButtonProps): JSX.Element {
  const classes = `ui-btn ui-btn--${variant}${iconOnly ? ' ui-btn--icon' : ''}${className == null ? '' : ` ${className}`}`;
  // A link that looks like a button is still a link. Handing it to base-ui would
  // relabel it role="button", costing the link role and open-in-new-tab.
  if (render != null) return cloneElement(render, { className: classes, ...props });
  return <BaseButton className={classes} {...props} />;
}

type TextVariant = 'body' | 'muted' | 'mono' | 'label';

// Four text roles, no free-floating font sizes. `label` is the small uppercase
// caption that titles a panel or a rail section.
export function Text({
  variant = 'body',
  as: As = 'span',
  className,
  children,
  ...rest
}: {
  variant?: TextVariant;
  as?: 'span' | 'p' | 'div' | 'dt' | 'dd';
  className?: string;
  children: ReactNode;
  title?: string;
  style?: React.CSSProperties;
}): JSX.Element {
  return (
    <As className={`ui-text ui-text--${variant}${className == null ? '' : ` ${className}`}`} {...rest}>
      {children}
    </As>
  );
}

export function Heading({ level = 2, children }: { level?: 1 | 2; children: ReactNode }): JSX.Element {
  const As = level === 1 ? 'h1' : 'h2';
  return <As className={`ui-h ui-h--${level}`}>{children}</As>;
}

export interface Option<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  // Colours the pressed state. Used only by the triage verdicts, where
  // traffic-light semantics beat palette purity.
  tone?: 'pick' | 'reject';
}

// One-of-N. The buttons are `.ui-btn`s like any other, so a filter chip and a
// toolbar button cannot drift apart in height or type.
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  stretch = false,
}: {
  options: Option<T>[];
  value: T | null;
  onChange: (value: T) => void;
  label: string;
  stretch?: boolean;
}): JSX.Element {
  return (
    <ToggleGroup
      className={`ui-seg${stretch ? ' ui-seg--stretch' : ''}`}
      aria-label={label}
      value={value == null ? [] : [value]}
      onValueChange={(next) => {
        const picked = next[next.length - 1];
        // Pressing the pressed item yields an empty array; a one-of-N control has
        // no "none", so that press is simply ignored.
        if (typeof picked === 'string') onChange(picked as T);
      }}
    >
      {options.map((option) => (
        <Toggle
          key={option.value}
          value={option.value}
          className={`ui-btn ui-btn--seg${option.tone == null ? '' : ` ui-btn--${option.tone}`}`}
        >
          {option.icon}
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

export function Select<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
}): JSX.Element {
  return (
    <BaseSelect.Root
      value={value}
      onValueChange={(next) => next != null && onChange(next as T)}
      // Without this the trigger renders the raw value, not the label.
      items={options.map((o) => ({ value: o.value, label: o.label }))}
    >
      <BaseSelect.Trigger className="ui-btn ui-btn--default" aria-label={label}>
        <BaseSelect.Value />
        <BaseSelect.Icon className="ui-btn__caret">
          <ChevronDown size={ICON} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner sideOffset={4}>
          <BaseSelect.Popup className="ui-popup">
            {options.map((option) => (
              <BaseSelect.Item key={option.value} value={option.value} className="ui-item">
                <BaseSelect.ItemIndicator className="ui-item__check">
                  <Check size={ICON} />
                </BaseSelect.ItemIndicator>
                <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  );
}

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
}): JSX.Element {
  return (
    <span className={`ui-input${grow ? ' ui-input--grow' : ''}`}>
      {icon}
      <Input
        value={value}
        aria-label={label}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onValueChange={onChange}
      />
    </span>
  );
}

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

// A menu of independent checkboxes: several can be on at once, and it stays open
// while they are being chosen.
export function CheckMenu<T extends string>({
  trigger,
  active = false,
  options,
  selected,
  onToggle,
}: {
  trigger: ReactNode;
  active?: boolean;
  options: Option<T>[];
  selected: readonly T[];
  onToggle: (value: T, checked: boolean) => void;
}): JSX.Element {
  return (
    <Menu.Root>
      {/* The trigger is the button itself, not a wrapper around one: base-ui
          needs a real <button> for its keyboard and ARIA wiring. */}
      <Menu.Trigger className="ui-btn ui-btn--default" aria-pressed={active}>
        {trigger}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4}>
          <Menu.Popup className="ui-popup">
            {options.map((option) => (
              <Menu.CheckboxItem
                key={option.value}
                className="ui-item"
                closeOnClick={false}
                checked={selected.includes(option.value)}
                onCheckedChange={(checked) => onToggle(option.value, checked)}
              >
                <Menu.CheckboxItemIndicator className="ui-item__check">
                  <Check size={ICON} />
                </Menu.CheckboxItemIndicator>
                {option.icon}
                {option.label}
              </Menu.CheckboxItem>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

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
        <Popover.Positioner sideOffset={4}>
          <Popover.Popup className="ui-popup ui-popup--pad">{children}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

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

export function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss: () => void }): JSX.Element | null {
  if (message == null) return null;
  return (
    <div className="error" role="alert">
      <span>{message}</span>
      <Button variant="ghost" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  label: string;
}): JSX.Element {
  return (
    <BaseSlider.Root
      className="ui-slider"
      value={value}
      min={min}
      max={max}
      step={step}
      onValueChange={(next) => typeof next === 'number' && onChange(next)}
    >
      <BaseSlider.Control className="ui-slider__control" aria-label={label}>
        <BaseSlider.Track className="ui-slider__track">
          <BaseSlider.Indicator className="ui-slider__fill" />
          <BaseSlider.Thumb className="ui-slider__thumb" />
        </BaseSlider.Track>
      </BaseSlider.Control>
    </BaseSlider.Root>
  );
}
