import { Field } from '../../ui/field';
import { type Option } from '../../ui/option';
import { SegmentedControl } from '../../ui/segmented_control';
import { Text } from '../../ui/text';
import { OriginalsChoiceStrings } from './originals_choice.strings';

type Originals = 'raws' | 'thumbnails';

const OPTIONS: Option<Originals>[] = [
  { value: 'raws', label: OriginalsChoiceStrings.syncOriginalRaws() },
  { value: 'thumbnails', label: OriginalsChoiceStrings.syncThumbnailsOnly() },
];

export function OriginalsChoice({
  keeps,
  onChange,
  disabled,
  tooltip,
}: {
  keeps: boolean;
  onChange: (keeps: boolean) => void;
  disabled?: boolean;
  tooltip?: string;
}): JSX.Element {
  return (
    <Field tooltip={tooltip}>
      <Text variant="label" as="span">
        {OriginalsChoiceStrings.keepOnThisDevice()}
      </Text>
      <SegmentedControl
        as="radio"
        stretch
        label={OriginalsChoiceStrings.keepOnThisDevice()}
        options={OPTIONS}
        value={keeps ? 'raws' : 'thumbnails'}
        onChange={(value) => onChange(value === 'raws')}
        disabled={disabled}
      />
    </Field>
  );
}
