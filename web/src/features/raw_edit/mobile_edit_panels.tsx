import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react';
import { buttonStyles } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { SliderIsolationContext } from '../../ui/slider_isolation';
import { color, derivedSize, size } from '../../ui/tokens.stylex';
import { MobileEditPanelsStrings as S } from './mobile_edit_panels.strings';
import { MobileEditPanelsPresenter } from './mobile_edit_panels_presenter';
import { MobileEditPanelsStore } from './mobile_edit_panels_store';

const styles = stylex.create({
  root: {
    display: 'contents',
  },
  footer: {
    position: 'fixed',
    insetInline: 0,
    bottom: 0,
    zIndex: 20,
    backgroundColor: color.ink,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    paddingTop: size.sheetPad,
    paddingBottom: `max(${size.sheetPad}, env(safe-area-inset-bottom))`,
  },
  tabs: {
    display: 'flex',
    gap: '4px',
    paddingInline: size.padX,
    overflowX: 'auto',
    scrollbarWidth: 'none',
  },
  tab: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    color: color.boneDim,
    justifyContent: 'center',
  },
  selected: {
    backgroundColor: color.slateSoft,
    color: color.bone,
    boxShadow: `inset 0 -2px 0 ${color.satin}`,
  },
  overlay: {
    position: 'fixed',
    insetInline: 0,
    bottom: derivedSize.sheetH,
    zIndex: 19,
    display: 'grid',
    gridTemplateColumns: 'minmax(0, 1fr)',
    gap: '8px',
    maxHeight: `min(55dvh, calc(100dvh - ${derivedSize.sheetH} - 64px))`,
    paddingBlock: size.sheetPad,
    paddingInline: size.padX,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    backgroundColor: color.ink,
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
    opacity: 0,
    transform: 'translateY(8px)',
    visibility: 'hidden',
    pointerEvents: 'none',
    transition: {
      default: 'opacity 160ms ease, transform 160ms ease, visibility 0s 160ms',
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
  },
  open: {
    opacity: 1,
    transform: 'translateY(0)',
    visibility: 'visible',
    pointerEvents: 'auto',
    transitionDelay: '0s',
  },
  adjusting: {
    opacity: 0,
    pointerEvents: 'none',
  },
});

export type MobileEditPanel = { id: string; title: string; content: ReactNode };

type Props = {
  panels: readonly MobileEditPanel[];
  scope: string;
  notice?: ReactNode;
};

export function MobileEditPanels({ scope, ...props }: Props): JSX.Element {
  return <MobileEditPanelsView key={scope} {...props} />;
}

const MobileEditPanelsView = observer(function MobileEditPanelsView({ panels, notice }: Omit<Props, 'scope'>): JSX.Element {
  const store = useMemo(() => new MobileEditPanelsStore(), []);
  const presenter = useMemo(() => new MobileEditPanelsPresenter(store), [store]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const id = useId();
  useEffect(() => presenter.dispose, [presenter]);
  const selected = panels.find((panel) => panel.id === store.selectedId);
  const expanded = store.expanded && selected != null;
  const active = store.activeSlider;
  const tabbableId = selected?.id ?? panels[0]?.id;
  return (
    <SliderIsolationContext.Provider value={{ active, begin: presenter.begin, end: presenter.end }}>
      <div {...stylex.props(styles.root)} onKeyDown={(event) => {
        if (event.key !== 'Escape' || !expanded || active != null) return;
        event.preventDefault();
        event.stopPropagation();
        presenter.close();
        if (selected != null) buttons.current.get(selected.id)?.focus();
      }}>
        <div {...stylex.props(styles.footer)}>
          <div role="tablist" aria-label={S.tabs()} {...stylex.props(styles.tabs)}>
            {panels.map((panel) => (
              <button
                key={panel.id}
                ref={(element) => {
                  if (element == null) buttons.current.delete(panel.id);
                  else buttons.current.set(panel.id, element);
                }}
                id={`${id}-${panel.id}`}
                type="button"
                role="tab"
                aria-controls={`${id}-panel`}
                aria-selected={expanded && selected?.id === panel.id}
                aria-expanded={expanded && selected?.id === panel.id}
                tabIndex={tabbableId === panel.id ? 0 : -1}
                disabled={active != null}
                onClick={() => presenter.toggle(panel.id)}
                onKeyDown={(event) => {
                  const next = presenter.navigate(panel.id, panels.map((entry) => entry.id), event.key);
                  if (next == null) return;
                  event.preventDefault();
                  event.stopPropagation();
                  buttons.current.get(next)?.focus();
                }}
                {...stylex.props(buttonStyles.base, focusRing.ring, styles.tab, expanded && selected?.id === panel.id && styles.selected)}
              >
                {panel.title}
              </button>
            ))}
          </div>
        </div>
        <div
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={selected == null ? undefined : `${id}-${selected.id}`}
          aria-hidden={!expanded}
          {...(expanded ? {} : { inert: '' })}
          {...stylex.props(styles.overlay, expanded && styles.open, active != null && styles.adjusting)}
        >
          {expanded && notice}
          {selected?.content}
        </div>
        {!expanded && notice && (
          <div role="status" {...stylex.props(styles.overlay, styles.open)}>{notice}</div>
        )}
      </div>
    </SliderIsolationContext.Provider>
  );
});
