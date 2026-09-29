import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { usePresenters, useSidebarStore } from '../../app/stores_context';
import { color } from '../../ui/tokens.stylex';
import { sidebarWidth } from './sidebar';
import { SidebarResizerStrings } from './sidebar_resizer.strings';

const styles = stylex.create({
  // Wider than the line it draws, so the edge can be caught without landing on the scrollbar.
  resizer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '6px',
    zIndex: 40,
    cursor: 'col-resize',
    touchAction: 'none',
    backgroundImage: `linear-gradient(${color.satin}, ${color.satin})`,
    backgroundPosition: 'center',
    backgroundSize: { default: '0 100%', ':hover': '3px 100%', ':focus-visible': '3px 100%' },
    backgroundRepeat: 'no-repeat',
    transition: 'background-size 150ms ease',
    outline: 'none',
  },
  resizerAt: (left: string) => ({ left }),
});

// The sidebar's own edge, dragged. Pointer x is the width outright, the sidebar being
// the first column of the shell; a fine pointer only, since a finger has the
// whole drawer to pull instead.
export const SidebarResizer = observer(function SidebarResizer(): JSX.Element {
  const store = useSidebarStore();
  const { sidebar } = usePresenters();

  return (
    <div
      {...stylex.props(
        styles.resizer,
        styles.resizerAt(`calc(${sidebarWidth(store.width)} - 3px)`),
      )}
      role="separator"
      aria-orientation="vertical"
      aria-label={SidebarResizerStrings.resizeSidebar()}
      tabIndex={0}
      onPointerDown={(e) => {
        // Without this the drag selects the sidebar's text instead of moving the edge.
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
        sidebar.setWidth(e.clientX);
      }}
      onDoubleClick={sidebar.toggleOpen}
      onKeyDown={(e) => {
        const steps = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (steps === 0) return;
        e.preventDefault();
        sidebar.nudgeWidth(steps);
      }}
    />
  );
});
