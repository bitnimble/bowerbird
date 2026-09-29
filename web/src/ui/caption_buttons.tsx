import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import {
  followCaptionPointer,
  setCaptionButtonsSize,
  windowCommand,
  windowIsMaximized,
  type CaptionButton,
  type CaptionPointer,
} from '../api/transport';
import { CaptionButtonsStrings } from './caption_buttons.strings';
import { focusRing } from './focus_ring';
import { HAS_CAPTION_BUTTONS } from './title_bar';
import { size } from './tokens.stylex';

const BUTTON_WIDTH = '46px';

const styles = stylex.create({
  bar: {
    position: 'fixed',
    top: 0,
    right: 0,
    zIndex: 100,
    display: 'flex',
  },
  button: {
    width: BUTTON_WIDTH,
    height: '40px',
    display: 'grid',
    placeItems: 'center',
    borderWidth: 0,
    padding: 0,
    fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'",
    fontSize: '10px',
    lineHeight: 1,
    color: '#ffffff',
    backgroundColor: 'transparent',
    transitionProperty: 'background-color, color',
    transitionDuration: '150ms, 100ms',
  },
  maximized: {
    height: '32px',
  },
  unfocused: {
    color: '#ffffff5d',
  },
  hovered: {
    color: '#ffffff',
    backgroundColor: '#ffffff0f',
    transitionDuration: '0s',
  },
  pressed: {
    color: '#ffffff',
    backgroundColor: '#ffffff0a',
    transitionDuration: '0s',
  },
  closeHovered: {
    color: '#ffffff',
    backgroundColor: '#c42b1c',
    transitionDuration: '0s',
  },
  closePressed: {
    color: '#ffffffb3',
    backgroundColor: '#c42b1ce6',
    transitionDuration: '0s',
  },
  // 3 buttons and a `Row` gap, less the page's padding.
  clear: {
    paddingRight: `calc(3 * ${BUTTON_WIDTH} + 8px - ${size.padX})`,
  },
});

const GLYPHS = {
  minimize: String.fromCodePoint(0xe921),
  maximize: String.fromCodePoint(0xe922),
  restore: String.fromCodePoint(0xe923),
  close: String.fromCodePoint(0xe8bb),
};

/** For a page's first row, whose end would otherwise sit under the caption buttons. */
export const CLEARS_CAPTION_BUTTONS = HAS_CAPTION_BUTTONS && styles.clear;

/** Minimise, maximise and close, drawn where the Windows app has no title bar to hold them. */
export function CaptionButtons(): JSX.Element | null {
  const bar = useRef<HTMLDivElement>(null);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [pointer, setPointer] = useState<CaptionPointer>({ hovered: null, pressed: null });

  useEffect(() => {
    if (!HAS_CAPTION_BUTTONS) return;
    const readMaximized = (): void => void windowIsMaximized().then(setMaximized);
    const focus = (): void => setFocused(true);
    const blur = (): void => setFocused(false);
    readMaximized();
    window.addEventListener('resize', readMaximized);
    window.addEventListener('focus', focus);
    window.addEventListener('blur', blur);
    const unfollow = followCaptionPointer(setPointer);
    return () => {
      window.removeEventListener('resize', readMaximized);
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', blur);
      unfollow();
    };
  }, []);

  useEffect(() => {
    const element = bar.current;
    if (element == null) return;
    let width = 0;
    let height = 0;
    // Hidden under a fullscreen photo, or its window would still answer for the corner.
    const report = (): void => {
      const shown = document.fullscreenElement == null;
      void setCaptionButtonsSize(shown ? width : 0, shown ? height : 0);
    };
    const observer = new ResizeObserver(([entry]) => {
      const box = entry?.devicePixelContentBoxSize[0];
      if (box == null) return;
      width = Math.round(box.inlineSize);
      height = Math.round(box.blockSize);
      report();
    });
    observer.observe(element, { box: 'device-pixel-content-box' });
    document.addEventListener('fullscreenchange', report);
    return () => {
      observer.disconnect();
      document.removeEventListener('fullscreenchange', report);
      void setCaptionButtonsSize(0, 0);
    };
  }, []);

  if (!HAS_CAPTION_BUTTONS) return null;
  const shared = { pointer, maximized, focused };
  return (
    <div
      ref={bar}
      {...stylex.props(styles.bar)}
      role="group"
      aria-label={CaptionButtonsStrings.windowControls()}
    >
      <CaptionButtonView
        kind="minimize"
        label={CaptionButtonsStrings.minimise()}
        glyph={GLYPHS.minimize}
        onClick={() => void windowCommand('minimize')}
        {...shared}
      />
      <CaptionButtonView
        kind="maximize"
        label={maximized ? CaptionButtonsStrings.restore() : CaptionButtonsStrings.maximise()}
        glyph={maximized ? GLYPHS.restore : GLYPHS.maximize}
        onClick={() => void windowCommand('toggle_maximize')}
        {...shared}
      />
      <CaptionButtonView
        kind="close"
        label={CaptionButtonsStrings.close()}
        glyph={GLYPHS.close}
        onClick={() => void windowCommand('close')}
        {...shared}
      />
    </div>
  );
}

function CaptionButtonView({
  kind,
  label,
  glyph,
  onClick,
  pointer,
  maximized,
  focused,
}: {
  kind: CaptionButton;
  label: string;
  glyph: string;
  onClick: () => void;
  pointer: CaptionPointer;
  maximized: boolean;
  focused: boolean;
}): JSX.Element {
  const close = kind === 'close';
  const pressed = pointer.pressed === kind;
  const hovered = !pressed && pointer.hovered === kind;
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      {...stylex.props(
        styles.button,
        maximized && styles.maximized,
        !focused && styles.unfocused,
        hovered && (close ? styles.closeHovered : styles.hovered),
        pressed && (close ? styles.closePressed : styles.pressed),
        focusRing.ring,
      )}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );
}
