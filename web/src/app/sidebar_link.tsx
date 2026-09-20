import * as stylex from '@stylexjs/stylex';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { NavLink, type NavLinkProps } from 'react-router-dom';
import { focusRing } from '../ui/focus_ring';
import { ICON } from '../ui/icon';
import { color, font, size } from '../ui/tokens.stylex';

// Every row of the drawer is a target, and these carry their own metrics rather than the
// buttons', so the token that grew every control on a finger has to be applied here too.
const COARSE = '@media (pointer: coarse)';

export const sidebarStyles = stylex.create({
  link: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    width: '100%',
    minHeight: { default: null, [COARSE]: size.controlH },
    paddingBlock: { default: '5px', [COARSE]: 0 },
    paddingInline: { default: '8px', [COARSE]: '10px' },
    borderRadius: size.radius,
    color: { default: color.boneDim, ':hover': color.bone },
    backgroundColor: { default: null, ':hover': color.slateSoft },
    fontSize: { default: '13px', [COARSE]: size.controlText },
  },
  active: {
    backgroundColor: color.slateSoft,
    color: color.bone,
    boxShadow: `inset 2px 0 0 ${color.satin}`,
  },
  button: {
    backgroundColor: { default: 'transparent', ':hover': color.slateSoft },
    borderWidth: 0,
    cursor: 'pointer',
    fontFamily: 'inherit',
    lineHeight: 'inherit',
    textAlign: 'left',
  },
  update: {
    color: { default: color.satin, ':hover': color.bone },
  },
  // The one thing in a row that must not give up width to a long name.
  icon: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
  },
  text: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // Leaves the badge after it beside the name, rather than at the row's far end.
  textFit: {
    flexGrow: 0,
    flexBasis: 'auto',
  },
  count: {
    marginLeft: 'auto',
    fontFamily: font.mono,
    fontSize: { default: '11px', [COARSE]: '13px' },
    color: color.boneDim,
  },
});

export function SidebarIcon({ icon: Icon }: { icon: LucideIcon }): JSX.Element {
  return <Icon size={ICON} {...stylex.props(sidebarStyles.icon)} />;
}

/** An entry's name, where it can be long enough to need cutting short. */
export function SidebarText({ fit = false, children }: { fit?: boolean; children: ReactNode }): JSX.Element {
  return <span {...stylex.props(sidebarStyles.text, fit && sidebarStyles.textFit)}>{children}</span>;
}

/** An entry of the sidebar that goes somewhere. */
export function SidebarLink({
  to,
  end,
  title,
  label,
  icon,
  children,
}: {
  to: string;
  end?: boolean;
  title?: string;
  label?: string;
  icon: LucideIcon;
  children: ReactNode;
}): JSX.Element {
  const styled = (isActive: boolean): ReturnType<typeof stylex.props> =>
    stylex.props(sidebarStyles.link, isActive && sidebarStyles.active, focusRing.ring);
  const className: NavLinkProps['className'] = ({ isActive }) => styled(isActive).className;
  return (
    <NavLink to={to} end={end} title={title} aria-label={label} className={className}>
      <SidebarIcon icon={icon} />
      {children}
    </NavLink>
  );
}

/** An entry of the sidebar that acts rather than navigates. */
export function SidebarButton({
  icon,
  tone,
  onClick,
  children,
}: {
  icon: LucideIcon;
  tone?: 'update';
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      {...stylex.props(sidebarStyles.link, sidebarStyles.button, tone === 'update' && sidebarStyles.update, focusRing.ring)}
      onClick={onClick}
    >
      <SidebarIcon icon={icon} />
      {children}
    </button>
  );
}
