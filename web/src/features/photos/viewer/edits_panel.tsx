import type * as stylex from '@stylexjs/stylex';
import type { ReactNode } from 'react';
import type { EditDoc } from '../../../../../src/schemas/photo_edits';
import { Panel } from '../../../ui/panel';
import { Text } from '../../../ui/text';
import { editRows } from './edit_rows';
import { MetaPanel } from './meta_panel';
import { PhotoDetailStrings } from './photo_detail_page.strings';
import type { Size } from './zoom_pan';

/** A photograph's edits, wherever they are listed. `doc` is null while they are still loading. */
export function EditsPanel({
  title,
  doc,
  frame,
  defaultOpen,
  style,
  children,
}: {
  title: string;
  doc: EditDoc | null;
  frame: Size | null;
  defaultOpen: boolean;
  style?: stylex.StyleXStyles;
  children?: ReactNode;
}): JSX.Element {
  const rows = doc == null ? [] : editRows(doc, frame);
  if (rows.length > 0) {
    return (
      <MetaPanel title={title} defaultOpen={defaultOpen} rows={rows} style={style}>
        {children}
      </MetaPanel>
    );
  }

  return (
    <Panel title={title} style={style}>
      <Text variant="muted" as="p">
        {doc == null ? PhotoDetailStrings.pending() : PhotoDetailStrings.noEdits()}
      </Text>
      {children}
    </Panel>
  );
}
