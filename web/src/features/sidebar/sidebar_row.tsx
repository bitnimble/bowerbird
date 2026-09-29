import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import type { ReactNode } from 'react';
import { NavLink, type NavLinkProps } from 'react-router-dom';
import { ChevronDown, ChevronRight, Network, PencilOff, type LucideIcon } from 'lucide-react';
import { CollectionListStrings } from '../../app/collection_list.strings';
import { usePresenters, useSidebarStore } from '../../app/stores_context';
import { focusRing } from '../../ui/focus_ring';
import { ICON } from '../../ui/icon';
import { Tooltip } from '../../ui/tooltip';
import { color, derivedSize, size } from '../../ui/tokens.stylex';
import { SidebarIcon, SidebarText, sidebarStyles } from './sidebar_link';
import { SidebarRowStrings } from './sidebar_row.strings';

const COARSE = '@media (pointer: coarse)';
const FINE = '@media (pointer: fine)';
// A tree row reaches out past the section's padding to the sidebar's edges: a stuck parent paints
// only its own box, and any gutter beside it is a strip the rows below scroll up through.
const SECTION_PAD = '8px';
// Also where a guide rule stands in the icon column of the row it belongs to.
const ROW_INSET = `calc(${size.sidebarStep} - 2px)`;
const COARSE_CHEV_SLOT = `calc(${size.controlH} + 14px)`;

const styles = stylex.create({
  section: {
    paddingTop: '10px',
    paddingInline: SECTION_PAD,
    paddingBottom: '2px',
  },
  badge: {
    color: color.boneDim,
  },
  row: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    height: derivedSize.sidebarRow,
    marginBlock: 0,
    marginInline: `calc(-1 * ${SECTION_PAD})`,
    // One rule per ancestor, drawn as the image over the sticky backdrop's colour so a stuck
    // parent keeps them. Rows abut, so what each draws stacks into a continuous rule.
    backgroundImage: `repeating-linear-gradient(to right, ${color.slate} 0 1px, transparent 1px ${size.sidebarStep})`,
    backgroundRepeat: 'no-repeat',
    // A pixel in from the icon box's edge: flush, the rule reads as leaning left of the glyph.
    backgroundPositionX: `calc(${ROW_INSET} + 1px)`,
  },
  // The open row's bar stands where its parent's rule would, so the row on it drops that rule.
  guides: (all: string, besideBar: string) => ({
    backgroundSize: { default: all, ':has(> [aria-current="page"])': besideBar },
  }),
  sticky: (top: string, zIndex: number) => ({
    position: 'sticky',
    top,
    // Shallower over deeper, counted down from further than a tree nests: a child pushed up by the
    // end of its parent's block would otherwise paint over the parent it slides under.
    zIndex,
    // Colour, not the shorthand, which would take the guide rules with it.
    backgroundColor: color.bower,
  }),
  rowLink: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    height: '100%',
    paddingLeft: ROW_INSET,
    // Where the count's right edge lands. On a fine pointer the chevron lies over the count; on a
    // finger nothing hovers, so the chevron stays shown and every row holds its slot, leaf rows
    // too, so counts line up.
    paddingRight: { default: '12px', [COARSE]: COARSE_CHEV_SLOT },
    // The chevron lies over the link, so without this the row drops its hover on reaching it.
    backgroundColor: {
      default: null,
      ':hover': color.slateSoft,
      [stylex.when.ancestor(':hover')]: color.slateSoft,
    },
    color: {
      default: color.boneDim,
      ':hover': color.bone,
      [stylex.when.ancestor(':hover')]: color.bone,
    },
  },
  // With no count to hold the chevron's slot open, the name holds it.
  rowLinkUncounted: {
    paddingRight: { default: '34px', [COARSE]: COARSE_CHEV_SLOT },
  },
  indent: (marginLeft: string) => ({ marginLeft }),
  // The count holds the slot the chevron lies over, never narrower than it, so the swap cannot
  // move the name.
  rowCount: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    minWidth: '20px',
    textAlign: 'right',
  },
  // A fine pointer's alone: a tap moves focus, so under a finger this would blank the count on
  // the way to opening a section.
  countSwapped: {
    visibility: {
      default: null,
      [FINE]: {
        default: null,
        [stylex.when.ancestor(':hover')]: 'hidden',
        [stylex.when.ancestor(':has(:focus-visible)')]: 'hidden',
      },
    },
  },
  chev: {
    position: 'absolute',
    right: { default: '12px', [COARSE]: '8px' },
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: { default: '20px', [COARSE]: size.controlH },
    height: { default: '20px', [COARSE]: size.controlH },
    padding: 0,
    borderWidth: 0,
    borderRadius: size.radius,
    backgroundColor: { default: 'transparent', ':hover': color.slate },
    color: { default: color.boneDim, ':hover': color.bone },
    cursor: 'pointer',
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      [stylex.when.ancestor(':has(:focus-visible)')]: 1,
      [COARSE]: 1,
    },
  },
});

export function SidebarSection({
  style,
  children,
}: {
  style?: stylex.StyleXStyles;
  children: ReactNode;
}): JSX.Element {
  return <div {...stylex.props(styles.section, style)}>{children}</div>;
}

// One row of the sidebar's tree, and whatever hangs under it. `sectionKey` is what
// makes it a section: it earns the chevron, it earns a place the children are
// drawn, and it earns the sticky, so a tree deep enough to fill the sidebar can
// still be closed from wherever the reader has scrolled to.
export const SidebarRow = observer(function SidebarRow({
  to,
  end,
  tooltip,
  icon,
  name,
  count,
  readOnly = false,
  originalsElsewhere = false,
  tone,
  depth,
  sectionKey,
  children,
}: {
  to: string;
  end?: boolean;
  tooltip?: string;
  icon: LucideIcon;
  name: string;
  count?: number;
  readOnly?: boolean;
  originalsElsewhere?: boolean;
  tone?: 'warning';
  depth: number;
  /** What its chevron opens, absent for a row with nothing under it. */
  sectionKey?: string;
  children?: ReactNode;
}): JSX.Element {
  const store = useSidebarStore();
  const { sidebar } = usePresenters();
  const open = sectionKey != null && store.isOpen(sectionKey);
  const guides = (levels: number): string => `calc(${size.sidebarStep} * ${levels}) 100%`;
  const link = (isActive: boolean): ReturnType<typeof stylex.props> =>
    stylex.props(
      sidebarStyles.link,
      styles.rowLink,
      sectionKey != null && count == null && styles.rowLinkUncounted,
      isActive && sidebarStyles.active,
      tone === 'warning' && sidebarStyles.warning,
      styles.indent(`calc(${size.sidebarStep} * ${depth})`),
      focusRing.ring,
    );
  const linkClass: NavLinkProps['className'] = ({ isActive }) => link(isActive).className;
  const linkStyle: NavLinkProps['style'] = ({ isActive }) => link(isActive).style;
  const readOnlyName = readOnly ? SidebarRowStrings.readOnlyName(name) : name;
  const spokenName = originalsElsewhere
    ? SidebarRowStrings.originalsElsewhereName(readOnlyName)
    : readOnlyName;

  return (
    <div>
      <div
        {...stylex.props(
          styles.row,
          styles.guides(guides(depth), guides(Math.max(0, depth - 1))),
          sectionKey != null &&
            styles.sticky(`calc(${derivedSize.sidebarRow} * ${depth})`, 999 - depth),
          stylex.defaultMarker(),
        )}
      >
        {/* The count is inside the link, so the row lights up as one thing under the
            pointer. The chevron cannot be - a button inside an anchor is not markup -
            so it is laid over the count's own place instead.
            Named rather than left to the two spans: adjacent inline text is read as one
            run-on word, so a library of twelve announces as "Reef12". */}
        <Tooltip label={tooltip}>
          <NavLink
            end={end}
            to={to}
            className={linkClass}
            style={linkStyle}
            aria-label={count == null ? undefined : SidebarRowStrings.rowHolding(spokenName, count)}
          >
            <SidebarIcon icon={icon} />
            <SidebarText fit={readOnly || originalsElsewhere}>{name}</SidebarText>
            {readOnly && (
              <PencilOff size={12} {...stylex.props(styles.badge)} aria-hidden>
                <title>{SidebarRowStrings.readOnly()}</title>
              </PencilOff>
            )}
            {originalsElsewhere && (
              <Network size={12} {...stylex.props(styles.badge)} aria-hidden>
                <title>{SidebarRowStrings.originalsElsewhere()}</title>
              </Network>
            )}
            {count != null && (
              <span
                {...stylex.props(
                  sidebarStyles.count,
                  styles.rowCount,
                  sectionKey != null && styles.countSwapped,
                )}
              >
                {count}
              </span>
            )}
          </NavLink>
        </Tooltip>
        {sectionKey != null && (
          <button
            type="button"
            {...stylex.props(styles.chev, focusRing.ring)}
            aria-expanded={open}
            aria-label={
              open ? CollectionListStrings.collapse(name) : CollectionListStrings.expand(name)
            }
            onClick={() => sidebar.toggle(sectionKey)}
          >
            {open ? <ChevronDown size={ICON} /> : <ChevronRight size={ICON} />}
          </button>
        )}
      </div>
      {open && children}
    </div>
  );
});
