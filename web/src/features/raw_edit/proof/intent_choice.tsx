import * as stylex from '@stylexjs/stylex';
import type { RenderingIntent } from '../../../../../src/schemas/rendering_intent';
import { Select } from '../../../ui/select';
import { Text } from '../../../ui/text';
import { styles as rows } from '../raw_edit_panel.stylex';
import { IntentChoiceStrings as strings } from './intent_choice.strings';

/** How an sRGB file or a print is brought inside its gamut, from the intents `intents` offers. */
export function IntentChoice<I extends RenderingIntent>({ value, onChange, intents }: {
  value: I;
  onChange: (intent: I) => void;
  intents: readonly I[];
}): JSX.Element {
  return (
    <div {...stylex.props(rows.control)}>
      <div {...stylex.props(rows.head, rows.headAboveSelect)}>
        <Text as="span" style={rows.name}>{strings.renderingIntent()}</Text>
      </div>
      <Select
        label={strings.renderingIntent()}
        options={intents.map((intent) => ({ value: intent, label: strings[intent]() }))}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}
