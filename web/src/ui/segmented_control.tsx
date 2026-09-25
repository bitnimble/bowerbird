import { Radio } from '@base-ui-components/react/radio';
import { RadioGroup } from '@base-ui-components/react/radio-group';
import { Toggle } from '@base-ui-components/react/toggle';
import { ToggleGroup } from '@base-ui-components/react/toggle-group';
import * as stylex from '@stylexjs/stylex';
import { buttonStyles } from './button';
import { focusRing } from './focus_ring';
import type { Option } from './option';
import { color, size } from './tokens.stylex';
import { Tooltip } from './tooltip';

const INK_ON_SATIN = '#08111f';
const INK_ON_MOSS = '#04180b';
const INK_ON_ROSE = '#200807';
// `data-checked` is the radio group's, `data-pressed` the toggle group's.
const CHECKED = '[data-checked]';
const PRESSED = '[data-pressed]';

const styles = stylex.create({
  group: {
    display: 'inline-flex',
    height: size.controlH,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: size.radius,
    overflow: 'hidden',
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  groupStretch: {
    display: 'flex',
    width: '100%',
  },
  // The group carries the border, so an item that kept its own would leave the group 2px taller
  // than every standalone button beside it.
  item: {
    height: '100%',
    borderWidth: 0,
    borderRightWidth: { default: '1px', ':last-child': 0 },
    borderRadius: 0,
    transition: 'background-color 150ms ease, color 150ms ease',
    backgroundColor: { default: color.slateSoft, [CHECKED]: color.satin, [PRESSED]: color.satin },
    color: { default: color.bone, [CHECKED]: INK_ON_SATIN, [PRESSED]: INK_ON_SATIN },
    fontWeight: { default: null, [CHECKED]: 600, [PRESSED]: 600 },
  },
  pick: {
    backgroundColor: { default: color.slateSoft, [CHECKED]: color.satin, [PRESSED]: color.moss },
    color: { default: color.bone, [CHECKED]: INK_ON_SATIN, [PRESSED]: INK_ON_MOSS },
  },
  reject: {
    backgroundColor: { default: color.slateSoft, [CHECKED]: color.satin, [PRESSED]: color.rose },
    color: { default: color.bone, [CHECKED]: INK_ON_SATIN, [PRESSED]: INK_ON_ROSE },
  },
  // `auto` basis rather than 0: equal shares sized the widest label by the narrowest, so it
  // clipped while its neighbours sat in whitespace.
  itemStretch: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 'auto',
    justifyContent: 'center',
    paddingInline: '6px',
    minWidth: 0,
    overflow: 'hidden',
  },
  // Lit at once so the press is seen, and left to fade out on its own when the hold ends.
  held: {
    backgroundColor: color.satin,
    color: INK_ON_SATIN,
    fontWeight: 600,
    transition: 'none',
  },
  heldPick: {
    backgroundColor: color.moss,
    color: INK_ON_MOSS,
  },
  heldReject: {
    backgroundColor: color.rose,
    color: INK_ON_ROSE,
  },
  // The control's real value stays unlit under a hold, or the photograph stepped to would light
  // its own verdict beside the one just given.
  underHold: {
    backgroundColor: color.slateSoft,
    color: color.bone,
    fontWeight: 400,
  },
});

/**
 * One-of-N. The buttons wear `buttonStyles` like any other, so a filter chip and a
 * toolbar button cannot drift apart in height or type.
 *
 * **`as="radio"` says one-of-N to a screen reader, and it is not the default.** A radio group is
 * the honest role for every control here - it names the group, says which member is current, and
 * moves the selection with the arrow keys - and that last part is why it is opt-in. The grid's
 * filters and view switcher sit on a page where the arrow keys walk the *photographs*, so a
 * radio group under the reader's focus would eat them: click "Rejects", press right, and the
 * selection changes instead of the cursor moving. Where a control is the only thing arrow keys
 * could sensibly mean - the editor's tool selector, on a stage with no cursor to walk - it takes
 * the role and the behaviour together.
 *
 * The two render identically. What differs is the role, the arrow keys, and that a radio cannot
 * be un-chosen - which is what a one-of-N means, and which the toggle group has to ignore an
 * empty selection by hand to imitate.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  held = null,
  onChange,
  label,
  stretch = false,
  as = 'toggle',
  focusable = true,
  style,
  itemStyle,
}: {
  options: Option<T>[];
  value: T | null;
  /**
   * Drawn as the chosen one while set, in place of `value`. `value` still decides what a press
   * means, so a control whose value moved under a held one is still pressable back to it.
   */
  held?: T | null;
  onChange: (value: T) => void;
  label: string;
  stretch?: boolean;
  as?: 'toggle' | 'radio';
  /**
   * Off inside a menu popup, where the first tabbable element takes the focus the
   * menu's own items need: a group there leaves every action in the popup
   * unreachable by keyboard, and no arrow key ever gets past it.
   */
  focusable?: boolean;
  style?: stylex.StyleXStyles;
  itemStyle?: stylex.StyleXStyles;
}): JSX.Element {
  const group = stylex.props(styles.group, stretch && styles.groupStretch, style);
  const tabIndex = focusable ? undefined : -1;
  const item = (option: Option<T>): ReturnType<typeof stylex.props> =>
    stylex.props(
      buttonStyles.base,
      option.iconOnly === true && buttonStyles.icon,
      focusRing.ring,
      styles.item,
      option.tone != null && styles[option.tone],
      stretch && styles.itemStretch,
      held != null && (option.value === held ? styles.held : styles.underHold),
      option.value === held && option.tone === 'pick' && styles.heldPick,
      option.value === held && option.tone === 'reject' && styles.heldReject,
      itemStyle,
    );
  const iconName = (option: Option<T>): string | undefined => (option.iconOnly === true ? option.label : undefined);
  const contents = (option: Option<T>): JSX.Element => (
    <>
      {option.icon}
      {option.iconOnly === true ? null : option.label}
      {option.hint != null && <span {...stylex.props(buttonStyles.hint)}>{option.hint}</span>}
    </>
  );

  if (as === 'radio') {
    return (
      <RadioGroup
        {...group}
        aria-label={label}
        value={value}
        onValueChange={(next) => {
          if (typeof next === 'string') onChange(next as T);
        }}
      >
        {options.map((option) => (
          <Tooltip key={option.value} label={iconName(option)}>
            <Radio.Root value={option.value} aria-label={iconName(option)} tabIndex={tabIndex} {...item(option)}>
              {contents(option)}
            </Radio.Root>
          </Tooltip>
        ))}
      </RadioGroup>
    );
  }

  return (
    <ToggleGroup
      {...group}
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
        <Tooltip key={option.value} label={iconName(option)}>
          <Toggle value={option.value} aria-label={iconName(option)} tabIndex={tabIndex} {...item(option)}>
            {contents(option)}
          </Toggle>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
}
