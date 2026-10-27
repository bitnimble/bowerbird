import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from '../../app/sidebar_presenter';
import { usePresenters, useSidebarStore } from '../../app/stores_context';
import { EdgeResizer } from '../../ui/edge_resizer';
import { sidebarWidth } from './sidebar';
import { SidebarResizerStrings } from './sidebar_resizer.strings';

const styles = stylex.create({
  // Wider than the line it draws, so the edge can be caught without landing on the scrollbar.
  edge: {
    top: 0,
    bottom: 0,
    width: '6px',
    zIndex: 40,
  },
  at: (left: string) => ({ left }),
});

// A fine pointer only, since a finger has the whole drawer to pull instead.
export const SidebarResizer = observer(function SidebarResizer(): JSX.Element {
  const store = useSidebarStore();
  const { sidebar } = usePresenters();

  return (
    <EdgeResizer
      axis="x"
      grows={1}
      value={store.width ?? SIDEBAR_DEFAULT_WIDTH}
      min={SIDEBAR_MIN_WIDTH}
      max={SIDEBAR_MAX_WIDTH}
      label={SidebarResizerStrings.resizeSidebar()}
      onResize={sidebar.setWidth}
      onNudge={sidebar.nudgeWidth}
      onDoubleClick={sidebar.toggleOpen}
      style={[styles.edge, styles.at(`calc(${sidebarWidth(store.width)} - 3px)`)]}
    />
  );
});
