import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { Folder } from 'lucide-react';
import { PathSegment, route } from '../../../../src/schemas/route';
import type { ShootNode } from '../../app/sidebar_store';
import { usePresenters, useSidebarStore } from '../../app/stores_context';
import { SidebarRow } from './sidebar_row';

const SidebarShoot = observer(function SidebarShoot({ node, depth }: { node: ShootNode; depth: number }): JSX.Element {
  return (
    <SidebarRow
      to={route(PathSegment.shoots(), node.shoot.id)}
      icon={Folder}
      name={node.shoot.name}
      count={node.shoot.photo_count}
      depth={depth}
      sectionKey={node.children.length === 0 ? undefined : `shoot:${node.shoot.id}`}
    >
      {node.children.map((child) => (
        <SidebarShoot key={child.shoot.id} node={child} depth={depth + 1} />
      ))}
    </SidebarRow>
  );
});

// Mounted only while the section is open, which is what makes the read lazy: a
// library whose shoots nobody asks for costs no request.
export const SidebarShoots = observer(function SidebarShoots({ libraryId }: { libraryId: string }): JSX.Element {
  const store = useSidebarStore();
  const { sidebar } = usePresenters();
  useEffect(() => void sidebar.loadShoots(libraryId), [sidebar, libraryId]);

  return (
    <>
      {(store.shootTrees.get(libraryId) ?? []).map((node) => (
        <SidebarShoot key={node.shoot.id} node={node} depth={2} />
      ))}
    </>
  );
});
