import { RenderingIntentSchema, type RenderingIntent } from '../../../../../src/schemas/rendering_intent';
import { SelectControl } from '../edit_control';
import { IntentChoiceStrings as strings } from './intent_choice.strings';

const INTENTS = RenderingIntentSchema.options.map((intent) => ({ value: intent, label: strings[intent]() }));

/** How an sRGB file or a print is brought inside its gamut. */
export function IntentChoice({ value, onChange }: {
  value: RenderingIntent;
  onChange: (intent: RenderingIntent) => void;
}): JSX.Element {
  return <SelectControl label={strings.renderingIntent()} options={INTENTS} value={value} onChange={onChange} />;
}
