import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { usePresenters, useViewerStore } from '../../../app/stores_context';
import { Panel } from '../../../ui/panel';
import { Text } from '../../../ui/text';
import { TextArea } from '../../../ui/text_area';
import { PhotoDetailStrings } from './photo_detail_page.strings';

// Its own component holding its own draft: on the page, a keystroke re-rendered
// every panel and the stage with them.
export const DetailNotes = observer(function DetailNotes({
  photoId,
  style,
}: {
  photoId: string;
  style?: stylex.StyleXStyles;
}): JSX.Element {
  const store = useViewerStore();
  const { photos } = usePresenters();
  const saved = store.detailFor(photoId)?.notes ?? '';
  const [notes, setNotes] = useState(saved);
  // Keyed on the photo alone. Following `notes` as well would let a save that
  // lands after the user has started typing again overwrite the field mid-edit.
  useEffect(() => setNotes(store.detailFor(photoId)?.notes ?? ''), [photoId, store.lastDetailId]);
  const dirty = notes !== saved;

  return (
    <Panel title={PhotoDetailStrings.notes()} style={style}>
      <TextArea
        label={PhotoDetailStrings.notes()}
        placeholder={PhotoDetailStrings.addANote()}
        value={notes}
        onChange={setNotes}
        onBlur={() => {
          if (dirty) void photos.setNotes(photoId, notes);
        }}
      />
      <Text variant="mono">
        {dirty ? PhotoDetailStrings.unsaved()
        : store.notesSavedAt != null ? PhotoDetailStrings.saved()
        : ''}
      </Text>
    </Panel>
  );
});
