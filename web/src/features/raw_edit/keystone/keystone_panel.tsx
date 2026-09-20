import * as stylex from '@stylexjs/stylex';
import { MoveHorizontal, MoveVertical, X } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { Button } from '../../../ui/button';
import { focusRing } from '../../../ui/focus_ring';
import { ICON } from '../../../ui/icon';
import type { Option } from '../../../ui/option';
import { Panel } from '../../../ui/panel';
import { SegmentedControl } from '../../../ui/segmented_control';
import { Text } from '../../../ui/text';
import { EditToolsStrings } from '../edit_tools.strings';
import type { RawEditPanelStyles } from '../raw_edit_panel.stylex';
import { RawEditPanelStrings } from '../raw_edit_panel.strings';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import type { StageStore } from '../stage/stage_store';
import type { GuideKind, KeystoneStore } from './keystone_store';

const GUIDE_KINDS: Option<GuideKind>[] = [
  {
    value: 'vertical',
    label: RawEditPanelStrings.guideVertical(),
    icon: <MoveVertical size={ICON} />,
  },
  {
    value: 'horizontal',
    label: RawEditPanelStrings.guideHorizontal(),
    icon: <MoveHorizontal size={ICON} />,
  },
];

/**
 * The perspective tool's own controls: which pair is being drawn, and the lines already down.
 *
 * **The two pairs are independent and the panel says so.** A pair of lines down edges that are
 * upright in life fixes the vertical; a pair across edges that are level fixes the horizontal;
 * neither needs the other and either may be drawn first. That was invisible when the tool was
 * four anonymous lines and a sentence about "the first two", and a reader who drew two
 * horizontals first was told they had done it wrong.
 *
 * The pair a line belongs to is the line's own direction (`isUpright`), so this picker chooses
 * what is about to be drawn rather than labelling anything - and a line that comes out the
 * other way joins the other pair, which the list below shows immediately.
 */
export const KeystonePanel = observer(function KeystonePanel({
  stage,
  store,
  presenter,
  styles,
}: {
  stage: StageStore;
  store: KeystoneStore;
  presenter: RawEditPresenter;
  styles: RawEditPanelStyles;
}): JSX.Element {
  const pairs = store.guidePairs;
  const kind = store.guideKind;
  return (
    <Panel style={styles.group} titleStyle={styles.groupTitle} title={EditToolsStrings.perspective()}>
      <SegmentedControl
        label={RawEditPanelStrings.guidesToDraw()}
        options={GUIDE_KINDS}
        value={kind}
        onChange={presenter.setGuideKind}
        stretch
      />

      <Text variant="muted" as="p">
        {pairs[kind].length === 0 ? RawEditPanelStrings.drawFirstGuide(kind)
        : pairs[kind].length === 1 ? RawEditPanelStrings.drawSecondGuide()
        : RawEditPanelStrings.pairCorrected()}
      </Text>

      {(['vertical', 'horizontal'] as const).map((each) =>
        pairs[each].map(({ index }, at) => (
          <div key={index} {...stylex.props(styles.guide)}>
            <span {...stylex.props(styles.swatch, styles[each])} />
            <Text as="span" style={styles.name}>
              {RawEditPanelStrings.guideName(each, at + 1)}
            </Text>
            <button
              type="button"
              {...stylex.props(styles.reset, focusRing.ring, styles.resetAtEnd)}
              aria-label={RawEditPanelStrings.removeGuide(each, at + 1)}
              title={RawEditPanelStrings.removeThisGuide()}
              onClick={() => presenter.removeGuide(index)}
            >
              <X size={12} {...stylex.props(styles.resetIcon)} />
            </button>
          </div>
        )),
      )}

      <div {...stylex.props(styles.actions)}>
        <Button
          onClick={presenter.clearKeystone}
          disabled={!stage.editable || (!store.keystoned && store.guides.length === 0)}
        >
          {RawEditPanelStrings.clearGuides()}
        </Button>
      </div>
    </Panel>
  );
});
