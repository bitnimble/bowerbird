import { Tooltip as BaseTooltip } from '@base-ui-components/react/tooltip';
import * as stylex from '@stylexjs/stylex';
import type { ReactElement } from 'react';
import { color, font, size } from './tokens.stylex';

const styles = stylex.create({
  positioner: {
    // Over `menuStyles.positioner`, so a row in an open menu can say why it is disabled.
    zIndex: 70,
    // Still in the tree while it fades, often over the neighbour the pointer is moving to.
    pointerEvents: 'none',
  },
  popup: {
    maxWidth: '320px',
    paddingBlock: '5px',
    paddingInline: '8px',
    borderRadius: size.radius,
    backgroundColor: color.slate,
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
    color: color.bone,
    fontFamily: font.body,
    fontSize: '12px',
    lineHeight: 1.35,
    overflowWrap: 'anywhere',
    transition: 'opacity 120ms ease',
    opacity: { default: 1, '[data-starting-style]': 0, '[data-ending-style]': 0 },
  },
});

export const TooltipProvider = BaseTooltip.Provider;

/**
 * Hover and focus text for `children`, which must pass its props and ref on to a DOM element.
 * `label` absent leaves the child as it is.
 */
export function Tooltip({
  label,
  children,
}: {
  label: string | undefined;
  children: ReactElement<Record<string, unknown>>;
}): JSX.Element {
  const isName = label === children.props['aria-label'];
  return (
    // Disabled rather than left out when there is no label, so a label arriving does not remount
    // the child and take its focus.
    <BaseTooltip.Root disabled={label == null} disableHoverablePopup>
      {/* The popup is only in the tree while open, so the description has to be on the trigger. */}
      <BaseTooltip.Trigger render={children} aria-description={isName ? undefined : label} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner {...stylex.props(styles.positioner)} sideOffset={6} collisionPadding={8}>
          <BaseTooltip.Popup {...stylex.props(styles.popup)} role="tooltip">
            {label}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
