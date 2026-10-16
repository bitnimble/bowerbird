import type { Activity } from '../../../../src/schemas/activity';
import { durationLabel } from '../../ui/format';
import { StatusDot, Strip, StripLabel } from '../../ui/strip';
import { rateKey } from '../libraries/remaining_rates';
import { ActivityStrings } from './activity.strings';

export function ActivityStrips({
  activities,
  libraryId,
  rates,
}: {
  activities: readonly Activity[];
  libraryId: string | null;
  rates: ReadonlyMap<string, number>;
}): JSX.Element {
  return (
    <>
      {activities.map((activity) => (
        <Strip key={activity.kind}>
          <StatusDot state="working" />
          <StripLabel>
            {ActivityStrings.label(activity)}
            <Pace remaining={activity.count} rate={rates.get(rateKey(libraryId, activity.kind))} />
          </StripLabel>
        </Strip>
      ))}
    </>
  );
}

/** How fast the work is going and when it should end, once there is a rate to say. */
export function Pace({
  remaining,
  rate,
}: {
  remaining: number;
  rate: number | undefined;
}): JSX.Element | null {
  if (rate == null) return null;
  return (
    <>
      {ActivityStrings.perSecond(rate.toFixed(1))}
      {ActivityStrings.left(durationLabel(remaining / rate))}
    </>
  );
}
