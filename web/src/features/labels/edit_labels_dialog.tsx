import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import * as stylex from '@stylexjs/stylex';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useId } from 'react';
import { LABEL_NAME_MAX } from '../../../../src/schemas/labels';
import { useLabelEditorStore, useLibrariesStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { DialogActions, DialogBody } from '../../ui/dialog_layout';
import { ErrorBanner } from '../../ui/error_banner';
import { Field } from '../../ui/field';
import { focusRing } from '../../ui/focus_ring';
import { ICON } from '../../ui/icon';
import { Modal } from '../../ui/modal';
import { ModalStrings } from '../../ui/modal.strings';
import { Select } from '../../ui/select';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { color, size } from '../../ui/tokens.stylex';
import { EditLabelsStrings } from './edit_labels_dialog.strings';
import type { DraftLabel } from './label_editor_store';

const styles = stylex.create({
  list: {
    display: 'grid',
    gap: '6px',
    margin: 0,
    padding: 0,
    listStyle: 'none',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto auto 1fr auto',
    alignItems: 'center',
    gap: '6px',
    position: 'relative',
    backgroundColor: color.slateSoft,
  },
  dragging: {
    zIndex: 1,
  },
  handle: {
    display: 'inline-flex',
    alignItems: 'center',
    height: size.controlH,
    padding: 0,
    borderWidth: 0,
    borderRadius: size.radius,
    backgroundColor: 'transparent',
    color: { default: color.boneDim, ':hover': color.bone },
    cursor: 'grab',
    // The pointer sensor needs the browser not to take the drag as a scroll on touch.
    touchAction: 'none',
  },
  swatch: {
    width: '24px',
    height: '24px',
    padding: 0,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: color.slate,
    borderRadius: '12px',
    backgroundColor: 'transparent',
    cursor: 'pointer',
    overflow: 'hidden',
    '::-webkit-color-swatch-wrapper': { padding: 0 },
    '::-webkit-color-swatch': { borderWidth: 0, borderRadius: '12px' },
    '::-moz-color-swatch': { borderWidth: 0, borderRadius: '12px' },
  },
  problem: {
    gridColumn: '3 / 4',
  },
  add: {
    alignSelf: 'flex-start',
  },
});

export const EditLabelsDialog = observer(function EditLabelsDialog(): JSX.Element {
  const editor = useLabelEditorStore();
  const libraries = useLibrariesStore();
  const { labels, confirm } = usePresenters();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const moved = (event: DragEndEvent): void => {
    if (event.over != null) labels.moveDraft(String(event.active.id), String(event.over.id));
  };

  return (
    <Modal
      open={editor.open}
      onOpenChange={(open) => {
        if (!open) labels.closeEditor();
      }}
      title={EditLabelsStrings.title()}
    >
      <DialogBody>
        {editor.choosesLibrary && editor.libraryId != null && (
          <Field>
            <Text variant="label" as="span">
              {EditLabelsStrings.library()}
            </Text>
            <Select
              label={EditLabelsStrings.library()}
              options={libraries.libraries.map((library) => ({ value: library.id, label: library.name }))}
              value={editor.libraryId}
              onChange={async (libraryId) => {
                const confirmed =
                  !editor.dirty ||
                  (await confirm.ask({
                    title: EditLabelsStrings.switchLibraryQuestion(),
                    body: EditLabelsStrings.discardWarning(),
                    action: EditLabelsStrings.switchLibrary(),
                  }));
                if (confirmed) labels.chooseEditorLibrary(libraryId);
              }}
            />
          </Field>
        )}

        {editor.drafts.length === 0 ?
          <Text variant="muted">{EditLabelsStrings.noLabels()}</Text>
        : <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={moved}>
            <SortableContext items={editor.drafts.map((draft) => draft.key)} strategy={verticalListSortingStrategy}>
              <ul {...stylex.props(styles.list)}>
                {editor.drafts.map((draft) => (
                  <DraftRow key={draft.key} draft={draft} duplicate={editor.duplicates.has(draft.key)} />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        }

        <Button style={styles.add} onClick={labels.addDraft}>
          <Plus size={ICON} />
          {EditLabelsStrings.newLabel()}
        </Button>

        {editor.error != null && <ErrorBanner>{editor.error}</ErrorBanner>}

        <DialogActions>
          <Button onClick={labels.closeEditor}>{ModalStrings.cancel()}</Button>
          <Button variant="primary" disabled={!editor.canSave} onClick={() => void labels.saveEditor()}>
            {EditLabelsStrings.save()}
          </Button>
        </DialogActions>
      </DialogBody>
    </Modal>
  );
});

const DraftRow = observer(function DraftRow({ draft, duplicate }: { draft: DraftLabel; duplicate: boolean }): JSX.Element {
  const { labels, confirm } = usePresenters();
  const problemId = useId();
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: draft.key,
  });
  const name = draft.name.trim() === '' ? EditLabelsStrings.labelName() : draft.name.trim();

  return (
    <li
      ref={setNodeRef}
      {...stylex.props(styles.row, isDragging && styles.dragging)}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        {...stylex.props(styles.handle, focusRing.ring)}
        aria-label={EditLabelsStrings.reorder(name)}
      >
        <GripVertical size={ICON} />
      </button>
      <input
        type="color"
        {...stylex.props(styles.swatch, focusRing.ring)}
        value={draft.colour}
        aria-label={EditLabelsStrings.colourFor(name)}
        onChange={(event) => labels.recolourDraft(draft.key, event.target.value)}
      />
      <TextField
        grow
        label={EditLabelsStrings.labelName()}
        value={draft.name}
        maxLength={LABEL_NAME_MAX}
        invalid={duplicate}
        describedBy={duplicate ? problemId : undefined}
        onChange={(value) => labels.renameDraft(draft.key, value)}
      />
      <Button
        variant="ghost"
        iconOnly
        aria-label={EditLabelsStrings.delete(name)}
        onClick={async () => {
          const confirmed =
            draft.photoCount === 0 ||
            (await confirm.ask({
              title: EditLabelsStrings.deleteQuestion(name),
              body: EditLabelsStrings.deleteWarning(draft.photoCount),
              action: EditLabelsStrings.confirmDelete(),
              tone: 'danger',
            }));
          if (confirmed) labels.removeDraft(draft.key);
        }}
      >
        <Trash2 size={ICON} />
      </Button>
      {duplicate && (
        <Text tone="error" id={problemId} style={styles.problem}>
          {EditLabelsStrings.duplicate()}
        </Text>
      )}
    </li>
  );
});
