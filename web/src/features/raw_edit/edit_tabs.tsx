import { Tabs } from '@base-ui-components/react/tabs';
import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { createContext, Fragment, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { buttonStyles } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { LabelFit } from '../../ui/label_fit';
import { color, size } from '../../ui/tokens.stylex';
import { Tooltip } from '../../ui/tooltip';
import { EditTabsPresenter } from './edit_tabs_presenter';
import { EditTabsStore } from './edit_tabs_store';
import type { EditPanel } from './mobile_edit_panels';
import { MobileEditPanelsStrings } from './mobile_edit_panels.strings';
import { styles as panelStyles } from './raw_edit_panel.stylex';

const ACTIVE = '[data-active]';

const styles = stylex.create({
  root: {
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    alignContent: 'start',
    gap: '8px',
  },
  strip: {
    justifyContent: 'flex-start',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: color.slate,
  },
  tabs: {
    display: 'flex',
    flexGrow: 1,
    gap: '2px',
  },
  tab: {
    flexGrow: 1,
    flexDirection: 'column',
    justifyContent: 'center',
    gap: '3px',
    height: 'auto',
    minHeight: size.controlH,
    paddingBlock: '5px',
    paddingInline: '6px',
    fontSize: '11.5px',
    borderColor: 'transparent',
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    backgroundColor: { default: 'transparent', [ACTIVE]: color.slateSoft },
    color: { default: color.boneDim, [ACTIVE]: color.bone },
    boxShadow: { default: null, [ACTIVE]: `inset 0 -2px 0 ${color.satin}` },
  },
});

/** Null where groups are not collapsible: a phone's sheet shows one at a time. */
export const GroupCollapse = createContext<{
  store: EditTabsStore;
  presenter: EditTabsPresenter;
} | null>(null);

export type EditTab = {
  id: string;
  title: string;
  icon: ReactNode;
  panels: readonly EditPanel[];
};

/** `tabs` null for a tool that takes the whole panel, which keeps the chosen tab for its return. */
export const EditTabs = observer(function EditTabs({
  tabs,
  panels,
  notice,
  style,
}: {
  tabs: readonly EditTab[] | null;
  panels: readonly EditPanel[];
  notice: ReactNode;
  style?: stylex.StyleXStyles;
}): JSX.Element {
  const store = useMemo(() => new EditTabsStore(), []);
  const presenter = useMemo(() => new EditTabsPresenter(store), [store]);
  const collapse = useMemo(() => ({ store, presenter }), [store, presenter]);
  const ids = tabs?.map((tab) => tab.id).join(' ');
  // Layout effect: a passive one paints the old tab for a frame before the new one's.
  useLayoutEffect(() => {
    if (ids != null && ids !== '') presenter.syncTabs(ids.split(' '));
  }, [ids, presenter]);
  const contents = (shown: readonly EditPanel[]): ReactNode => (
    <GroupCollapse.Provider value={collapse}>
      {shown.map(({ id, content }) => (
        <Fragment key={id}>{content}</Fragment>
      ))}
    </GroupCollapse.Provider>
  );

  const first = tabs?.[0];
  if (tabs == null || first == null) {
    return (
      <div {...stylex.props(panelStyles.panel, style)}>
        {notice}
        {contents(panels)}
      </div>
    );
  }
  const selected = tabs.find((tab) => tab.id === store.selectedId) ?? first;
  return (
    <Tabs.Root
      value={selected.id}
      onValueChange={presenter.select}
      {...stylex.props(styles.root, style)}
    >
      <LabelFit
        items={tabs.map(({ id, icon, title }) => ({ key: id, icon, label: title }))}
        selected={selected.id}
        rowStyle={styles.tabs}
        itemStyle={(labelled) => [buttonStyles.base, !labelled && buttonStyles.icon, styles.tab]}
        style={styles.strip}
      >
        {(labelled) => (
          <Tabs.List aria-label={MobileEditPanelsStrings.tabs()} {...stylex.props(styles.tabs)}>
            {tabs.map((tab) => {
              const named = labelled(tab.id);
              return (
                <Tooltip key={tab.id} label={named ? undefined : tab.title}>
                  <Tabs.Tab
                    value={tab.id}
                    aria-label={named ? undefined : tab.title}
                    {...stylex.props(
                      buttonStyles.base,
                      !named && buttonStyles.icon,
                      focusRing.inside,
                      styles.tab,
                    )}
                  >
                    {tab.icon}
                    {named && tab.title}
                  </Tabs.Tab>
                </Tooltip>
              );
            })}
          </Tabs.List>
        )}
      </LabelFit>
      {notice}
      <Tabs.Panel value={selected.id} {...stylex.props(panelStyles.panel)}>
        {contents(selected.panels)}
      </Tabs.Panel>
    </Tabs.Root>
  );
});
