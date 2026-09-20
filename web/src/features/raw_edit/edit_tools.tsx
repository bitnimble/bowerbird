import { Crop, Eraser, MousePointer2, Move3d, Search } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { ICON } from '../../ui/icon';
import type { Option } from '../../ui/option';
import { SegmentedControl } from '../../ui/segmented_control';
import { EditToolsStrings } from './edit_tools.strings';
import type { EditTool } from './edit_tool';
import type { RawEditPresenter } from './stage/raw_edit_presenter';
import type { StageStore } from './stage/stage_store';
import type { LoupeStore } from './loupe/loupe_store';

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
  { value: 'cursor', label: EditToolsStrings.cursor(), icon: <MousePointer2 size={ICON} />, iconOnly: true },
  { value: 'loupe', label: EditToolsStrings.loupe(), icon: <Search size={ICON} />, iconOnly: true },
  { value: 'crop', label: EditToolsStrings.crop(), icon: <Crop size={ICON} />, iconOnly: true },
  { value: 'perspective', label: EditToolsStrings.perspective(), icon: <Move3d size={ICON} />, iconOnly: true },
  { value: 'repair', label: EditToolsStrings.repair(), icon: <Eraser size={ICON} />, iconOnly: true },
];

export const EditToolbar = observer(function EditToolbar({
  stage,
  loupe,
  presenter,
}: {
  stage: StageStore;
  loupe: LoupeStore;
  presenter: RawEditPresenter;
}): JSX.Element {
  // A radio group: what the pointer is for is one of five, and the stage under it has no cursor
  // for the arrow keys to walk - so they can move the selection, which is what they mean here.
  //
  // The glass goes where the picture was prepared elsewhere: what it claims to show is the
  // export's own pixels, and what a backend open holds is the picture at a level.
  const offered = TOOLS.filter((tool) => tool.value !== 'loupe' || !stage.preparedElsewhere);

  return (
    <SegmentedControl
      as="radio"
      label={EditToolsStrings.tool()}
      options={offered}
      value={loupe.tool}
      onChange={presenter.setTool}
    />
  );
});
