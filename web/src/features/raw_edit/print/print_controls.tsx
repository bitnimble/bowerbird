import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Fragment, type ReactNode } from 'react';
import { MobileEditPanels } from '../mobile_edit_panels';
import { PrintPanel } from './print_panel';
import { PrintPanelStrings } from './print_panel.strings';
import type { PrintPresenter } from './print_presenter';
import type { PrintStore } from './print_store';

const styles = stylex.create({
  panels: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
    alignContent: 'start',
    gap: '8px',
  },
});

export const PrintControls = observer(function PrintControls({ store, presenter, disabled, mobile, notice }: {
  store: PrintStore;
  presenter: PrintPresenter;
  disabled: boolean;
  mobile: boolean;
  notice?: ReactNode;
}): JSX.Element {
  const titles = {
    paper: PrintPanelStrings.paper(),
    lighting: PrintPanelStrings.lighting(),
    orientation: store.surface ? PrintPanelStrings.deviceTilt() : PrintPanelStrings.rotation(),
  };
  const panels = (['paper', 'lighting', 'orientation'] as const).map((section) => ({
    id: section,
    title: titles[section],
    content: <PrintPanel store={store} presenter={presenter} disabled={disabled} section={section} />,
  }));
  if (mobile) return <MobileEditPanels panels={panels} scope="print" notice={notice} />;
  return <div {...stylex.props(styles.panels)}>
    {notice}
    {panels.map(({ id, content }) => <Fragment key={id}>{content}</Fragment>)}
  </div>;
});
