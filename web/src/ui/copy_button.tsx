import * as stylex from '@stylexjs/stylex';
import { Check, Copy, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CopyButtonStrings } from './copy_button.strings';
import { focusRing } from './focus_ring';
import { color } from './tokens.stylex';

type Result = 'idle' | 'copied' | 'failed';

const LABEL: Record<Result, () => string> = {
  idle: CopyButtonStrings.copy,
  copied: CopyButtonStrings.copied,
  failed: CopyButtonStrings.failed,
};

const styles = stylex.create({
  button: {
    paddingBlock: 0,
    paddingRight: 0,
    paddingLeft: '6px',
    borderWidth: 0,
    backgroundColor: 'transparent',
    color: { default: color.boneDim, ':hover': color.bone },
    cursor: 'pointer',
    verticalAlign: '-2px',
  },
});

export function CopyButton({ text }: { text: string }): JSX.Element {
  const [result, setResult] = useState<Result>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);

  const settle = (next: Result): void => {
    setResult(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult('idle'), 1200);
  };

  return (
    <button
      type="button"
      {...stylex.props(styles.button, focusRing.ring)}
      aria-label={LABEL[result]()}
      onClick={() => {
        // no navigator.clipboard at all off a secure origin, and a library is served over LAN http
        const copying = navigator.clipboard?.writeText(text);
        if (copying == null) {
          settle('failed');
          return;
        }
        void copying.then(() => settle('copied'), () => settle('failed'));
      }}
    >
      {result === 'copied' ? <Check size={12} /> : result === 'failed' ? <X size={12} /> : <Copy size={12} />}
    </button>
  );
}
