import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { Fragment } from 'react';
import { MobileEditPanels, type MobileEditPanel } from '../mobile_edit_panels';
import type { SoftProof } from '../proof/soft_proof';
import { PrintPanel, type PrintSection } from './print_panel';
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

/** What a proof has to offer: nothing for the library's own rendition, and only what it can show otherwise. */
export function proofPanels(proof: SoftProof, store: PrintStore, presenter: PrintPresenter, disabled: boolean): MobileEditPanel[] {
  const sections: PrintSection[] =
    proof === 'srgb' ? ['tone']
    : proof === 'print' ? ['paper']
    : proof === 'print3d' ? ['paper', 'lighting', 'orientation']
    : [];
  const titles: Record<PrintSection, string> = {
    tone: PrintPanelStrings.highlights(),
    paper: PrintPanelStrings.paper(),
    lighting: PrintPanelStrings.lighting(),
    orientation: store.surface ? PrintPanelStrings.deviceTilt() : PrintPanelStrings.rotation(),
  };
  return sections.map((section) => ({
    id: section,
    title: titles[section],
    content: <PrintPanel store={store} presenter={presenter} disabled={disabled} section={section} />,
  }));
}

export const PrintControls = observer(function PrintControls({ proof, store, presenter, disabled, mobile }: {
  proof: SoftProof;
  store: PrintStore;
  presenter: PrintPresenter;
  disabled: boolean;
  mobile: boolean;
}): JSX.Element {
  const panels = proofPanels(proof, store, presenter, disabled);
  if (mobile) return <MobileEditPanels panels={panels} scope="print" />;
  return <div {...stylex.props(styles.panels)}>
    {panels.map(({ id, content }) => <Fragment key={id}>{content}</Fragment>)}
  </div>;
});
