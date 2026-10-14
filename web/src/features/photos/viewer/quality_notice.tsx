import * as stylex from '@stylexjs/stylex';
import { needsHdrVideo } from 'avif-hdr-video';
import { X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useDeviceSettingsStore, usePresenters } from '../../../app/stores_context';
import { ICON } from '../../../ui/icon';
import { InlineIconButton } from '../../../ui/inline_icon_button';
import { Text } from '../../../ui/text';
import { color } from '../../../ui/tokens.stylex';
import { QualityNoticeStrings } from './quality_notice.strings';

const styles = stylex.create({
  notice: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 2,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '8px',
    paddingBlock: '4px',
    paddingInline: '10px',
    backgroundColor: color.slateSoft,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: color.slate,
  },
});

/** Says what Firefox costs the photo on screen, until closed on this device. */
export const QualityNotice = observer(function QualityNotice({
  where,
}: {
  where: 'viewer' | 'editor';
}): JSX.Element | null {
  const device = useDeviceSettingsStore();
  const { deviceSettings } = usePresenters();
  const closed =
    where === 'viewer' ? device.viewerQualityNoticeClosed : device.editorQualityNoticeClosed;
  if (closed || !needsHdrVideo()) return null;
  return (
    <div {...stylex.props(styles.notice)} role="note">
      <Text tone="warning">{QualityNoticeStrings[where]()}</Text>
      <InlineIconButton
        label={QualityNoticeStrings.dismiss()}
        onClick={() => deviceSettings.closeQualityNotice(where)}
      >
        <X size={ICON} />
      </InlineIconButton>
    </div>
  );
});
