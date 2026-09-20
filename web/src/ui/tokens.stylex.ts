import * as stylex from '@stylexjs/stylex';

export const color = stylex.defineVars({
  ink: '#14161a',
  bower: '#0b0d11',
  slate: '#232833',
  slateSoft: '#1a1e26',
  satin: '#4c7df0',
  glass: '#7fd4e8',
  bone: '#e8e4da',
  boneDim: '#8b8f99',
  ochre: '#d98a3a',
  rose: '#e2685f',
  moss: '#5fb87a',
  field: '#0f1319',
});

export const font = stylex.defineVars({
  display: "'Space Grotesk', 'Trebuchet MS', sans-serif",
  body: "'IBM Plex Sans', system-ui, -apple-system, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace",
});

const COARSE = '@media (pointer: coarse)';

export const size = stylex.defineVars({
  // Mirrored by `DEFAULT_WIDTH` in `sidebar_presenter.ts`.
  sidebar: '208px',
  sidebarStep: '16px',
  // Mirrored by `SIDEBAR_MAX` and `SIDEBAR_SHARE` in `drawer_swipe.ts`.
  sidebarW: 'min(280px, 82vw)',
  // 44px is the smallest target a finger reliably lands on.
  controlH: { default: '30px', [COARSE]: '44px' },
  // Not 14px on touch: iOS Safari zooms into a focused field under 16px and never zooms back out.
  controlText: { default: '13px', [COARSE]: '16px' },
  bodyText: { default: '14px', [COARSE]: '16px' },
  radius: '4px',
  // Mirrors `GRID_GAP` in `grid_layout.ts`.
  gridGap: '2px',
  // Mirrors `TILE_PAD`.
  tilePad: '4px',
  ring: '2px',
  sheetPad: '8px',
  padX: '14px',
  padB: '20px',
});

export const derivedSize = stylex.defineVars({
  sidebarRow: { default: '28px', [COARSE]: size.controlH },
  cellRadius: `calc(${size.radius} + ${size.tilePad})`,
  sheetH: `calc(${size.controlH} + ${size.sheetPad} + max(${size.sheetPad}, env(safe-area-inset-bottom)) + 1px)`,
});
