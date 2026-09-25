import { Tv } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect } from 'react';
import { useAppSettingsStore, useFrameTvStore, usePresenters } from '../../app/stores_context';
import { ICON } from '../../ui/icon';
import { MenuAction } from '../../ui/menu_items';
import { Submenu } from '../../ui/submenu';
import { SendToFrameTvStrings } from './send_to_frame_tv.strings';

/** A menu row sending to the one Frame TV on the network, or a submenu choosing between several. */
export const SendToFrameTv = observer(function SendToFrameTv({
  onSend,
}: {
  onSend: (tvId: string) => void;
}): JSX.Element | null {
  const settings = useAppSettingsStore();
  const store = useFrameTvStore();
  const { frameTv } = usePresenters();
  // Mounted as the menu opens, so each open looks again for a TV switched on since the last.
  useEffect(() => {
    void frameTv.search();
  }, [frameTv]);

  if (!settings.frameTvEnabled) return null;
  const label = SendToFrameTvStrings.sendToFrameTv();
  const icon = <Tv size={ICON} />;
  if (store.tvs.length > 1) {
    return (
      <Submenu label={label} icon={icon} options={store.tvs.map((tv) => ({ value: tv.id, label: tv.name }))} onSelect={onSend} />
    );
  }
  const tv = store.tvs[0];
  const missing = store.searching ? SendToFrameTvStrings.searching() : SendToFrameTvStrings.noneFound();
  return (
    <MenuAction
      option={{ value: tv?.id ?? '', label, icon, disabled: tv == null, tooltip: tv?.name ?? missing }}
      onSelect={onSend}
    />
  );
});
