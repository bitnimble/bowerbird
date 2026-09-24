import * as stylex from '@stylexjs/stylex';
import { RenderingIntentSchema, type RenderingIntent } from '../../../../../src/schemas/rendering_intent';
import { Select } from '../../../ui/select';
import { Text } from '../../../ui/text';
import { styles as rows } from '../raw_edit_panel.stylex';
import { IntentChoiceStrings as strings } from './intent_choice.strings';

const INTENTS = RenderingIntentSchema.options.map((intent) => ({ value: intent, label: strings[intent]() }));

/** How an sRGB file or a print is brought inside its gamut. */
export function IntentChoice({ value, onChange }: {
  value: RenderingIntent;
  onChange: (intent: RenderingIntent) => void;
}): JSX.Element {
  return (
    <div {...stylex.props(rows.control)}>
      <div {...stylex.props(rows.head, rows.headAboveSelect)}>
        <Text as="span" style={rows.name}>{strings.renderingIntent()}</Text>
      </div>
      <Select label={strings.renderingIntent()} options={INTENTS} value={value} onChange={onChange} />
    </div>
  );
}
