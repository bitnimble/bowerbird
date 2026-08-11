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
    previewExposure: record('previewExposure'),
    settleExposure: record('settleExposure'),
    previewBalance: record('previewBalance'),
    settleBalance: record('settleBalance'),
    previewStraighten: record('previewStraighten'),
    settleStraighten: record('settleStraighten'),
    setCropping: record('setCropping'),
    setKeystoning: record('setKeystoning'),
    clearKeystone: record('clearKeystone'),
    cropToBounds: record('cropToBounds'),
    turn: record('turn'),
    undo: record('undo'),
    redo: record('redo'),
  } as unknown as RawEditPresenter;
  return { presenter, calls };
}

function open(doc: Partial<ReturnType<typeof neutralEdits>> = {}): {
  calls: { name: string; value: unknown }[];
  store: RawEditStore;
} {
  const store = new RawEditStore();
  store.doc = { ...neutralEdits(), ...doc };
  store.width = 4000;
  store.height = 3000;
  store.status = 'live';
  const { presenter, calls } = recording();
  render(<RawEditPanel store={store} presenter={presenter} onDone={() => {}} />);
  return { calls, store };
}

const press = (testId: string): void => {
  screen.getByTestId(testId).click();
};

describe('the edit panel', () => {
  test('opens the tools its buttons name', () => {
    const { calls } = open();

    press('raw-edit-crop');
    press('raw-edit-keystone');
    press('raw-edit-turn-right');
    press('raw-edit-turn-left');

    expect(calls).toEqual([
      { name: 'setCropping', value: true },
      { name: 'setKeystoning', value: true },
      { name: 'turn', value: 90 },
      { name: 'turn', value: -90 },
    ]);
  });

  test('says what each tool will do next, rather than what it is called', () => {
    open({ cropLeft: 0.1, keystone: [1, 0, 0, 0, 1, 0, 0, 0.2] });

    expect(screen.getByTestId('raw-edit-crop').textContent).toBe('Adjust crop');
    expect(screen.getByTestId('raw-edit-keystone').textContent).toBe('Adjust perspective');
  });

  test('offers nothing to trim on a frame with no geometry on it', () => {
    const { store } = open();

    expect(screen.getByTestId('raw-edit-crop-to-bounds')).toHaveProperty('disabled', true);
    expect(store.trimmable).toBe(false);
  });

  test('offers to trim once a straighten has left something to trim', () => {
    const { calls } = open({ cropAngle: 4 });

    expect(screen.getByTestId('raw-edit-crop-to-bounds')).toHaveProperty('disabled', false);
    press('raw-edit-crop-to-bounds');
    // The names, not the arguments. This button is wired straight to the method rather than
    // through a closure, so React hands it the click event - and comparing one of those
    // structurally walks the whole DOM through its circular references and never returns.
    expect(calls.map((call) => call.name)).toEqual(['cropToBounds']);
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
});
