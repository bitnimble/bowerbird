// The panel against a presenter that only records, which is the seam a control lives on.
//
// **What a button does is not arithmetic**, so it cannot be answered the way the store's rules
// are: it is a component, a click, and whether anything was asked of the presenter. That was
// being answered by opening a real RAW in Playwright.
//
// **The sliders are not here, and that is the library rather than a choice.** Base UI's slider
// does not act on a keypress, a `change` or a pointer sequence outside a real browser - not
// through our wrapper and not used directly, with a layout box and a live `ResizeObserver` in
// front of it - while a plain React input in the same document answers all three. Their wiring
// stays in `raw_editing.spec.ts`, where a browser can say.
import { afterEach, describe, expect, test } from 'bun:test';
import { neutralEdits } from '../../../../../src/schemas/photo_edits';
import { registerDom } from '../../../test_dom';
import { RawEditPanel } from '../raw_edit_panel';
import { RawEditStore } from '../raw_edit_store';
import type { RawEditPresenter } from '../raw_edit_presenter';

// The DOM first, then the library that reaches for it as it is imported. The alternative is a
// preload, which would install one for the server's suites too - they share this runner.
registerDom();
const { cleanup, render, screen } = await import('@testing-library/react');

afterEach(cleanup);

function recording(): { presenter: RawEditPresenter; calls: { name: string; value: unknown }[] } {
  const calls: { name: string; value: unknown }[] = [];
  const record =
    (name: string) =>
    (value?: unknown): void => {
      calls.push({ name, value });
    };
  const presenter = {
    preview: record('preview'),
    settle: record('settle'),
    previewBalance: record('previewBalance'),
    settleBalance: record('settleBalance'),
    previewStraighten: record('previewStraighten'),
    settleStraighten: record('settleStraighten'),
    clearKeystone: record('clearKeystone'),
    setCropToFit: record('setCropToFit'),
  } as unknown as RawEditPresenter;
  return { presenter, calls };
}

function open(
  doc: Partial<ReturnType<typeof neutralEdits>> = {},
  asShot: { temperature: number; tint: number } | null = null,
): {
  calls: { name: string; value: unknown }[];
  store: RawEditStore;
} {
  const store = new RawEditStore();
  store.doc = { ...neutralEdits(), ...doc };
  store.width = 4000;
  store.height = 3000;
  store.status = 'live';
  store.asShot = asShot;
  const { presenter, calls } = recording();
  render(<RawEditPanel store={store} presenter={presenter} />);
  return { calls, store };
}

describe('the edit panel', () => {
  // The trim is a habit rather than an act now: it says whether the *next* straighten takes
  // the crop with it, so what the panel owes is the state and the way to turn it off.
  test('carries the crop-to-fit habit, and hands a change of it to the presenter', () => {
    const { calls, store } = open();
    const check = screen.getByTestId('raw-edit-crop-to-fit') as HTMLInputElement;

    expect(store.cropToFit).toBe(true);
    expect(check.checked).toBe(true);
    check.click();
    expect(calls).toEqual([{ name: 'setCropToFit', value: false }]);
  });

  test('shows the exposure in the document own unit', () => {
    open({ exposure: -1.5 });
    expect(screen.getByTestId('raw-edit-panel').textContent).toContain('-1.50 EV');
  });

  test('closes the white balance pair on a file that records no neutral', () => {
    open();
    expect(screen.queryByTestId('raw-edit-temperature')).toBeNull();
    expect(screen.getByTestId('raw-edit-white-balance').textContent).toContain('no camera neutral');
  });

  // The reader gets back to neutral without hunting for the number: the sliders cannot be
  // driven here (see the note at the top), so what is asserted is the button beside them.
  test('puts a moved parameter back where it started', () => {
    const { calls } = open({ contrast: 40 });

    screen.getByLabelText('Reset Contrast').click();
    expect(calls).toEqual([{ name: 'settle', value: { contrast: 0 } }]);
  });

  test('offers nothing to reset on a parameter nobody has moved', () => {
    open();
    expect(screen.getByLabelText('Reset Contrast').className).toContain('is-clean');
  });

  // Null on both halves, not the illuminant's own numbers: a stored 5487 pasted onto the next
  // photograph is a rebalance nobody asked for, where "As Shot" means that frame's own neutral.
  test('puts the white balance back to what the camera metered', () => {
    const { calls } = open(
      { temperature: 6500, tint: 20, whiteBalanceMode: 'Custom' },
      { temperature: 5487.3, tint: 11.4 },
    );

    // Either half, because the pair moves as one: a temperature beside the camera's own tint
    // is not the balance the camera made.
    screen.getByLabelText('Reset Tint').click();
    expect(calls).toEqual([
      { name: 'settle', value: { whiteBalanceMode: 'As Shot', temperature: null, tint: null } },
    ]);
  });
});
