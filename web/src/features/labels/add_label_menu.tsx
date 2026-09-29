import { Popover } from '@base-ui-components/react/popover';
import * as stylex from '@stylexjs/stylex';
import { Plus, Settings } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { LABEL_NAME_MAX } from '../../../../src/schemas/labels';
import { useLabelsStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { ICON } from '../../ui/icon';
import { menuStyles } from '../../ui/menu_styles';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { color } from '../../ui/tokens.stylex';
import { AddLabelMenuStrings } from './add_label_menu.strings';
import { EditLabelsStrings } from './edit_labels_dialog.strings';

const styles = stylex.create({
  // An uncoloured pill, dashed where a label's is filled.
  add: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    height: '22px',
    paddingInline: '7px 8px',
    borderWidth: '1px',
    borderStyle: 'dashed',
    borderColor: { default: color.boneDim, ':hover': color.bone },
    borderRadius: '11px',
    backgroundColor: 'transparent',
    color: { default: color.boneDim, ':hover': color.bone },
    fontSize: '13.2px',
    lineHeight: 1,
    cursor: 'pointer',
  },
  popup: {
    display: 'grid',
    gap: '4px',
    width: '240px',
  },
  row: {
    width: '100%',
    borderWidth: 0,
    backgroundColor: { default: 'transparent', ':hover': color.slate },
    color: { default: color.boneDim, ':hover': color.bone },
    textAlign: 'start',
  },
  search: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
  },
  swatch: {
    width: '8px',
    height: '8px',
  },
  empty: {
    paddingInline: '9px',
    paddingBlock: '6px',
  },
});

export const AddLabelMenu = observer(function AddLabelMenu({
  photoId,
  libraryId,
  applied,
}: {
  photoId: string;
  libraryId: string;
  applied: readonly string[];
}): JSX.Element {
  const store = useLabelsStore();
  const { labels } = usePresenters();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const all = store.labelsOf(libraryId);
  const wanted = query.trim().toLowerCase();
  const offered = all.filter(
    (label) => !applied.includes(label.id) && label.name.toLowerCase().includes(wanted),
  );
  const creatable = wanted !== '' && !all.some((label) => label.name.toLowerCase() === wanted);

  const close = (): void => {
    setOpen(false);
    setQuery('');
  };
  const pick = (labelId: string): void => {
    close();
    void labels.labelPhoto(photoId, labelId, true);
  };
  const create = (): void => {
    const name = query.trim();
    close();
    void labels.createForPhoto(photoId, libraryId, name);
  };

  return (
    <Popover.Root open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <Popover.Trigger {...stylex.props(styles.add, focusRing.ring)}>
        <Plus size={12} />
        {AddLabelMenuStrings.addLabel()}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          {...stylex.props(menuStyles.positioner)}
          sideOffset={4}
          align="start"
          sticky
        >
          <Popover.Popup
            {...stylex.props(menuStyles.popup, styles.popup)}
            aria-label={AddLabelMenuStrings.addLabel()}
          >
            <div {...stylex.props(styles.search)}>
              <TextField
                grow
                autoFocus
                label={AddLabelMenuStrings.findOrCreate()}
                placeholder={AddLabelMenuStrings.findOrCreate()}
                value={query}
                maxLength={LABEL_NAME_MAX}
                onChange={setQuery}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || wanted === '') return;
                  if (offered.length === 1) pick(offered[0]!.id);
                  else if (creatable) create();
                }}
              />
              <Button
                variant="ghost"
                iconOnly
                aria-label={EditLabelsStrings.open()}
                onClick={() => {
                  close();
                  void labels.openEditor(libraryId);
                }}
              >
                <Settings size={ICON} />
              </Button>
            </div>
            {offered.map((label) => (
              <button
                key={label.id}
                type="button"
                {...stylex.props(menuStyles.item, styles.row, focusRing.ring)}
                onClick={() => pick(label.id)}
              >
                <span
                  {...stylex.props(menuStyles.dot, styles.swatch)}
                  style={{ backgroundColor: label.colour }}
                />
                {label.name}
              </button>
            ))}
            {creatable && (
              <button
                type="button"
                {...stylex.props(menuStyles.item, styles.row, focusRing.ring)}
                onClick={create}
              >
                <Plus size={ICON} />
                {AddLabelMenuStrings.create(query.trim())}
              </button>
            )}
            {offered.length === 0 && !creatable && (
              <Text variant="muted" style={styles.empty}>
                {all.length === 0
                  ? AddLabelMenuStrings.typeToCreate()
                  : wanted === ''
                    ? AddLabelMenuStrings.allApplied()
                    : AddLabelMenuStrings.noMatches()}
              </Text>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
