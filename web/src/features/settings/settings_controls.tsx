import * as stylex from '@stylexjs/stylex';
import { observer } from 'mobx-react-lite';
import { useEffect, useState, type ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import { type Settings, type UpdateSettingsRequest } from '../../../../src/schemas/settings';
import { useAppSettingsStore, usePresenters } from '../../app/stores_context';
import { Button } from '../../ui/button';
import { focusRing } from '../../ui/focus_ring';
import { ICON } from '../../ui/icon';
import { PanelTitle } from '../../ui/panel';
import { Text } from '../../ui/text';
import { TextField } from '../../ui/text_field';
import { color } from '../../ui/tokens.stylex';
import { SettingsStrings } from './settings_page.strings';

const styles = stylex.create({
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr auto',
    alignItems: 'center',
    gap: '4px 12px',
    paddingBlock: '6px',
    borderTopWidth: { default: 0, [stylex.when.siblingBefore(':is(*)')]: '1px' },
    borderTopStyle: 'solid',
    borderTopColor: color.slate,
  },
  off: {
    opacity: 0.45,
  },
  left: {
    gridColumn: '1',
  },
  // The row's own padding is the space under a hint; a margin would be a second helping of it.
  hint: {
    margin: 0,
  },
  value: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    justifyContent: 'flex-end',
  },
  group: {
    marginTop: '18px',
    marginBottom: '8px',
  },
});

export const settingStyles = stylex.create({
  // A five-digit pixel edge plus its spinner, so a column of them reads as a column.
  input: {
    width: '10ch',
  },
});

// A reset handler, or nothing where there is nothing to undo.
//
// `undefined` covers both reasons for nothing: the value already is the default,
// and the defaults have not arrived from the server yet. A default that is
// legitimately null - `last_viewer_rendition` - is still a value to go back to.
export function resetTo<T>(current: T, fallback: T | undefined, apply: (value: T) => void): (() => void) | undefined {
  if (fallback === undefined || current === fallback) return undefined;
  return () => apply(fallback);
}

// A fractional step is what says the field takes decimals, and "1" beside a 0.05
// step reads as a whole-number setting that has run out of range.
export function showNumber(value: number, step?: number): string {
  if (step == null || Number.isInteger(step) || !Number.isInteger(value)) return String(value);
  return value.toFixed(1);
}

// One tuning knob: what it is, the control, and why you would move it. A reason
// rather than a boolean for `disabled`, because a control that cannot be used
// and does not say why is worse than one that is simply missing.
//
// `onReset` only when the value differs from the shipped default: a control that
// already holds the default has nothing to undo.
export function SettingRow({
  label,
  hint,
  disabledReason,
  onReset,
  children,
}: {
  label: string;
  hint?: ReactNode;
  disabledReason?: string;
  onReset?: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <div
      {...stylex.props(styles.row, disabledReason != null && styles.off, stylex.defaultMarker())}
      title={disabledReason}
    >
      <span {...stylex.props(styles.left)}>{label}</span>
      <div {...stylex.props(styles.value)}>
        {onReset != null && (
          <Button
            iconOnly
            variant="ghost"
            aria-label={SettingsStrings.resetSetting(label)}
            title={SettingsStrings.resetSetting(label)}
            onClick={onReset}
          >
            <RotateCcw size={ICON} />
          </Button>
        )}
        {children}
      </div>
      {hint != null && (
        <Text variant="mono" as="p" style={[styles.left, styles.hint]}>
          {hint}
        </Text>
      )}
    </div>
  );
}

export function GroupTitle({ children }: { children: ReactNode }): JSX.Element {
  return <PanelTitle style={styles.group}>{children}</PanelTitle>;
}

export type SettingOf<T> = { [K in keyof Settings]: Settings[K] extends T ? K : never }[keyof Settings];

export function useSettingWriter(): (patch: UpdateSettingsRequest) => Promise<boolean> {
  const { appSettings, toasts } = usePresenters();
  return async (patch) => {
    try {
      await appSettings.update(patch);
      return true;
    } catch (err) {
      toasts.showError(SettingsStrings.couldNotSaveSetting(), (err as Error).message);
      return false;
    }
  };
}

// Committed on blur or Enter rather than per keystroke: every character of "3840"
// would otherwise be a round trip, and "3" is a size the server would accept.
// `scale` is for UI units that differ from storage (e.g. seconds on screen, ms on the wire).
export const NumberSetting = observer(function NumberSetting({
  field,
  label,
  hint,
  disabledReason,
  scale = 1,
  min,
  max,
  step,
  suffix,
}: {
  field: SettingOf<number>;
  label: string;
  hint?: ReactNode;
  disabledReason?: string;
  scale?: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}): JSX.Element {
  const store = useAppSettingsStore();
  const write = useSettingWriter();
  const value = store.settings?.[field];
  const [draft, setDraft] = useState(value == null ? '' : showNumber(value / scale, step));

  useEffect(() => setDraft(value == null ? '' : showNumber(value / scale, step)), [value, scale, step]);

  async function commit(): Promise<void> {
    const nextDisplay = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(nextDisplay)) {
      // scale ≠ 1 is a unit conversion into integer storage (seconds → ms); leave
      // fractional settings alone so 0.5 denoise does not become 1.
      const next = scale === 1 ? nextDisplay : Math.round(nextDisplay * scale);
      if (next !== value) await write({ [field]: next } as UpdateSettingsRequest);
    }
    // Whatever the server made of it, including refusing it outright, is what
    // the field goes back to showing.
    const stored = store.settings?.[field];
    setDraft(stored == null ? '' : showNumber(stored / scale, step));
  }

  return (
    <SettingRow
      label={label}
      hint={hint}
      disabledReason={disabledReason}
      onReset={resetTo(value, store.defaults?.[field], (v) => void write({ [field]: v } as UpdateSettingsRequest))}
    >
      <TextField
        inputStyle={settingStyles.input}
        type="number"
        min={min}
        max={max}
        step={step}
        label={label}
        suffix={suffix}
        value={draft}
        disabled={disabledReason != null}
        onChange={setDraft}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && void commit()}
      />
    </SettingRow>
  );
});

export const TextSetting = observer(function TextSetting({
  field,
  label,
  placeholder,
  hint,
}: {
  field: SettingOf<string>;
  label: string;
  placeholder?: string;
  hint?: ReactNode;
}): JSX.Element {
  const store = useAppSettingsStore();
  const write = useSettingWriter();
  const value = store.settings?.[field];
  const [draft, setDraft] = useState(value ?? '');

  useEffect(() => setDraft(value ?? ''), [value]);

  async function commit(): Promise<void> {
    if (draft !== value) await write({ [field]: draft } as UpdateSettingsRequest);
    setDraft(store.settings?.[field] ?? '');
  }

  return (
    <SettingRow
      label={label}
      hint={hint}
      onReset={resetTo(value, store.defaults?.[field], (v) => void write({ [field]: v } as UpdateSettingsRequest))}
    >
      <TextField
        inputStyle={settingStyles.input}
        label={label}
        value={draft}
        placeholder={placeholder}
        onChange={setDraft}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && void commit()}
      />
    </SettingRow>
  );
});

export const ToggleSetting = observer(function ToggleSetting({
  field,
  label,
  hint,
  disabledReason,
}: {
  field: SettingOf<boolean>;
  label: string;
  hint?: ReactNode;
  disabledReason?: string;
}): JSX.Element {
  const store = useAppSettingsStore();
  const write = useSettingWriter();
  const value = store.settings?.[field] ?? false;

  return (
    <SettingRow
      label={label}
      hint={hint}
      disabledReason={disabledReason}
      onReset={resetTo(value, store.defaults?.[field], (v) => void write({ [field]: v } as UpdateSettingsRequest))}
    >
      <input
        {...stylex.props(focusRing.ring)}
        type="checkbox"
        aria-label={label}
        disabled={disabledReason != null}
        checked={value}
        onChange={(e) => void write({ [field]: e.currentTarget.checked } as UpdateSettingsRequest)}
      />
    </SettingRow>
  );
});
