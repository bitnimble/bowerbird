import { type Denoiser } from '../../../../src/schemas/photo_edits';
import type { Option } from '../../ui/option';
import { RawEditPanelStrings } from './raw_edit_panel.strings';

export const DENOISERS: Option<Denoiser>[] = [
  { value: 'galosh', label: RawEditPanelStrings.denoiserGalosh() },
  { value: 'pmrid', label: RawEditPanelStrings.denoiserPmrid() },
];
