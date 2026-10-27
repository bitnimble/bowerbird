import { Button as BaseButton } from '@base-ui-components/react/button';
import * as stylex from '@stylexjs/stylex';
import { cloneElement, forwardRef, type ReactElement, type ReactNode } from 'react';
import { focusRing } from './focus_ring';
import { color, font, size } from './tokens.stylex';
import { Tooltip } from './tooltip';

type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
export type StyleArg = stylex.StyleXArray<
  | null
  | undefined
  | boolean
  | stylex.CompiledStyles
  | Readonly<[stylex.CompiledStyles, stylex.InlineStyles]>
>;
type StyleProps = ReturnType<typeof stylex.props>;

// `focusableWhenDisabled` leaves the button enabled and sets `aria-disabled` instead.
const DISABLED = '[aria-disabled="true"]';
const HOVER = ':hover:not(:disabled):not([aria-disabled="true"])';
const INK_ON_SATIN = '#08111f';

/**
 * Every control's metrics: a filter chip, a menu trigger and a toolbar button are the same
 * object wearing different paint, so none of them sets its own height or type size.
 */
export const buttonStyles = stylex.create({
  base: {
    height: size.controlH,
    fontSize: size.controlText,
    lineHeight: 1,
    backgroundColor: color.slateSoft,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: color.slate, [HOVER]: color.slateLight },
    borderRadius: size.radius,
    paddingBlock: 0,
    paddingInline: '10px',
    cursor: { default: 'pointer', ':disabled': 'not-allowed', [DISABLED]: 'not-allowed' },
    opacity: { default: null, ':disabled': 0.45, [DISABLED]: 0.45 },
    color: color.bone,
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    whiteSpace: 'nowrap',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  default: {},
  icon: {
    paddingInline: 0,
    width: size.controlH,
    justifyContent: 'center',
  },
  primary: {
    backgroundColor: { default: color.satin, [HOVER]: '#6791f4' },
    borderColor: { default: color.satin, [HOVER]: color.slateLight },
    color: { default: INK_ON_SATIN, [HOVER]: color.bone },
    fontWeight: 600,
  },
  danger: {
    color: { default: color.rose, [HOVER]: color.bone },
  },
  ghost: {
    backgroundColor: 'transparent',
    borderColor: { default: 'transparent', [HOVER]: color.slateLight },
    color: { default: color.boneDim, [HOVER]: color.bone },
  },
  holdsBadge: {
    position: 'relative',
  },
  caret: {
    display: 'inline-flex',
    marginLeft: 'auto',
    color: color.boneDim,
  },
  // At the label's own size, so the two share a baseline.
  hint: {
    opacity: 0.55,
    marginLeft: '1px',
  },
  hintText: {
    fontFamily: font.mono,
    fontSize: '11px',
  },
  badge: {
    position: 'absolute',
    top: '-5px',
    right: '-5px',
    minWidth: '16px',
    height: '16px',
    paddingBlock: 0,
    paddingInline: '4px',
    borderRadius: '8px',
    backgroundColor: color.satin,
    // Parted from a pressed trigger, which is the same satin.
    boxShadow: `0 0 0 2px ${color.ink}`,
    color: INK_ON_SATIN,
    fontFamily: font.mono,
    fontSize: '11px',
    fontWeight: 600,
    lineHeight: '16px',
    textAlign: 'center',
  },
});

/** The trigger styles of a button of `variant`, for a Base UI part that renders the `<button>` itself. */
export function buttonProps(
  variant: ButtonVariant,
  iconOnly: boolean,
  ...more: StyleArg[]
): StyleProps {
  return stylex.props(
    buttonStyles.base,
    buttonStyles[variant],
    iconOnly && buttonStyles.icon,
    focusRing.ring,
    ...more,
  );
}

interface ButtonProps {
  variant?: ButtonVariant;
  iconOnly?: boolean;
  children?: ReactNode;
  disabled?: boolean;
  // For a button that disables itself when pressed, so the keyboard focus stays on it.
  focusableWhenDisabled?: boolean;
  type?: 'button' | 'submit';
  /** Defaults to the `aria-label` of a button that is only an icon. */
  tooltip?: string;
  /**
   * -1 inside a menu popup, where the first tabbable element takes the focus the
   * menu's own items need. Everywhere else the default is what you want.
   */
  tabIndex?: number;
  style?: stylex.StyleXStyles;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
  'aria-expanded'?: boolean;
  'aria-current'?: 'page';
  onClick?: (event: React.MouseEvent) => void;
  // For a button whose meaning is press-and-hold rather than press: stack
  // triage's peek shows the other photo for as long as it is held.
  onPointerDown?: (event: React.PointerEvent) => void;
  onPointerUp?: (event: React.PointerEvent) => void;
  onPointerCancel?: (event: React.PointerEvent) => void;
  onPointerLeave?: (event: React.PointerEvent) => void;
  // Renders the button as something else (a router Link, an anchor) while
  // keeping the metrics and keyboard behaviour.
  render?: ReactElement<Record<string, unknown>>;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    iconOnly = false,
    style,
    render,
    tooltip,
    focusableWhenDisabled,
    ...props
  },
  ref,
): JSX.Element {
  const pressed = variant === 'default' && props['aria-pressed'] === true;
  const styled = buttonProps(pressed ? 'primary' : variant, iconOnly, style);
  return (
    <Tooltip label={tooltip ?? (iconOnly ? props['aria-label'] : undefined)}>
      {/* A link that looks like a button is still a link. Handing it to base-ui would
          relabel it role="button", costing the link role and open-in-new-tab. */}
      {render != null ? (
        cloneElement(render, { ...styled, ...props, ref })
      ) : (
        <BaseButton
          ref={ref}
          focusableWhenDisabled={focusableWhenDisabled}
          {...styled}
          {...props}
        />
      )}
    </Tooltip>
  );
});

/** A keyboard shortcut, dimmed after a control's label. */
export function ButtonHint({
  children,
  style,
  'aria-hidden': ariaHidden,
}: {
  children: ReactNode;
  style?: stylex.StyleXStyles;
  'aria-hidden'?: boolean;
}): JSX.Element {
  return (
    <span aria-hidden={ariaHidden} {...stylex.props(buttonStyles.hint, style)}>
      <span {...stylex.props(buttonStyles.hintText)}>{children}</span>
    </span>
  );
}
