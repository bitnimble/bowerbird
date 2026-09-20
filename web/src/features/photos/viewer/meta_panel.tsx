import type * as stylex from '@stylexjs/stylex';
import { Fragment, useState, type ReactNode } from 'react';
import { MetaList, MetaTerm, MetaValue } from '../../../ui/meta_list';
import { MoreLess } from '../../../ui/more_less';
import { Panel } from '../../../ui/panel';
import type { Row } from './edit_rows';

// Two rows visible, the rest one click away. Every panel then costs the same
// three lines, so the column stays scannable however much a camera recorded.
const VISIBLE_ROWS = 2;

export function MetaPanel({
  title,
  rows,
  defaultOpen,
  style,
  children,
}: {
  title: string;
  rows: Row[];
  defaultOpen: boolean;
  style?: stylex.StyleXStyles;
  children?: ReactNode;
}): JSX.Element {
  // Null until the user has an opinion, so the panel follows the layout's default
  // when the next photo changes it and stops following the moment they toggle it.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? defaultOpen;
  const shown = open ? rows : rows.slice(0, VISIBLE_ROWS);
  const hidden = rows.length - VISIBLE_ROWS;

  return (
    <Panel title={title} style={style}>
      <MetaList>
        {shown.map(([name, value]) => (
          <Fragment key={name}>
            <MetaTerm>{name}</MetaTerm>
            <MetaValue>{value}</MetaValue>
          </Fragment>
        ))}
      </MetaList>
      {hidden > 0 && <MoreLess count={hidden} open={open} onToggle={() => setToggled(!open)} />}
      {children}
    </Panel>
  );
}
