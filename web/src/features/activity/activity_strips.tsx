import type { Activity } from '../../../../src/schemas/activity';
import { StatusDot, Strip, StripLabel } from '../../ui/strip';
import { ActivityStrings } from './activity.strings';

export function ActivityStrips({ activities }: { activities: readonly Activity[] }): JSX.Element {
  return <>{activities.map((activity) => (
    <Strip key={activity.kind}>
      <StatusDot state="working" />
      <StripLabel>{ActivityStrings.label(activity)}</StripLabel>
    </Strip>
  ))}</>;
}
