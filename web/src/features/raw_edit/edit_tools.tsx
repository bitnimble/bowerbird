import { Crop, MousePointer2, Move3d, RotateCcw, RotateCw, Search } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Button } from '../../ui/button';
import { ICON } from '../../ui/icon';
import type { Option } from '../../ui/option';
import { SegmentedControl } from '../../ui/segmented_control';
import type { RawEditPresenter } from './raw_edit_presenter';
import type { EditTool, RawEditStore } from './raw_edit_store';

/**
 * What the pointer does on the stage, as the one-of-N it is.
 *
 * Both geometry tools were buttons in the panel that read "Crop" and then "Done cropping",
 * which is a mode wearing a command's clothes: nothing said what the pointer was currently
 * for, and leaving a tool meant finding the button that had just changed its own label.
 *
 * Icons alone, because this is a toolbar in a bar that has to stay on one line, and each
 * still names itself to a screen reader and on hover.
 */
const TOOLS: Option<EditTool>[] = [
  {
    value: 'cursor',
    label: 'Cursor',
    icon: <MousePointer2 size={ICON} />,
    iconOnly: true,
    testId: 'raw-edit-cursor',
  },
  {
    value: 'loupe',
    label: 'Loupe',
    icon: <Search size={ICON} />,
    iconOnly: true,
    // Not `raw-edit-loupe`, which is the glass the overlay puts on the stage.
    testId: 'raw-edit-loupe-tool',
  },
  { value: 'crop', label: 'Crop', icon: <Crop size={ICON} />, iconOnly: true, testId: 'raw-edit-crop' },
  {
    value: 'perspective',
    label: 'Perspective',
    icon: <Move3d size={ICON} />,
    iconOnly: true,
    testId: 'raw-edit-keystone',
  },
];

export const EditToolbar = observer(function EditToolbar({
  store,
  presenter,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  return <SegmentedControl label="Tool" options={TOOLS} value={store.tool} onChange={presenter.setTool} />;
});

/**
 * The quarter turns, beside the zoom rather than in the panel.
 *
 * They are not a parameter: nothing about a turn is judged by dragging, and the picture they
 * act on is the one on the stage - so they belong with the other things that change what the
 * stage shows, not in a column of sliders.
 */
export const EditTurns = observer(function EditTurns({
  store,
  presenter,
}: {
  store: RawEditStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  const disabled = store.doc == null;

  return (
    <>
      <Button
        iconOnly
        aria-label="Rotate left"
        title="Rotate left"
        disabled={disabled}
        onClick={() => presenter.turn(-90)}
        data-testid="raw-edit-turn-left"
      >
        <RotateCcw size={ICON} />
      </Button>
      <Button
        iconOnly
        aria-label="Rotate right"
        title="Rotate right"
        disabled={disabled}
        onClick={() => presenter.turn(90)}
        data-testid="raw-edit-turn-right"
      >
        <RotateCw size={ICON} />
      </Button>
    </>
  );
});
