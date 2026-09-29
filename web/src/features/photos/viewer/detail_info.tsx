import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import { useLabelsStore, usePresenters, useViewerStore } from '../../../app/stores_context';
import { Panel } from '../../../ui/panel';
import { Text } from '../../../ui/text';
import { TextArea } from '../../../ui/text_area';
import { AddLabelMenu } from '../../labels/add_label_menu';
import { LabelPill } from '../../labels/label_pill';
import { PhotoDetailStrings } from './photo_detail_page.strings';

const styles = stylex.create({
  labels: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '4px',
    marginBlock: '8px',
  },
});

// Its own component holding its own draft: on the page, a keystroke re-rendered
// every panel and the stage with them.
export const DetailInfo = observer(function DetailInfo({
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
    <Panel title={PhotoDetailStrings.info()} style={style}>
      <DetailLabels photoId={photoId} />
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
        {dirty
          ? PhotoDetailStrings.unsaved()
          : store.notesSavedAt != null
            ? PhotoDetailStrings.saved()
            : ''}
      </Text>
    </Panel>
  );
});

const DetailLabels = observer(function DetailLabels({
  photoId,
}: {
  photoId: string;
}): JSX.Element | null {
  const detail = useViewerStore().detailFor(photoId);
  const labelsStore = useLabelsStore();
  const { labels } = usePresenters();
  if (detail == null) return null;
  const applied = labelsStore
    .labelsOf(detail.library_id)
    .filter((label) => detail.label_ids.includes(label.id));

  return (
    <div role="list" aria-label={PhotoDetailStrings.labels()} {...stylex.props(styles.labels)}>
      {applied.map((label) => (
        <LabelPill
          key={label.id}
          name={label.name}
          colour={label.colour}
          onRemove={() => void labels.labelPhoto(photoId, label.id, false)}
        />
      ))}
      <AddLabelMenu photoId={photoId} libraryId={detail.library_id} applied={detail.label_ids} />
    </div>
  );
});
