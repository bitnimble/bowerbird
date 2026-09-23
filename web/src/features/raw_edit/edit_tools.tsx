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
