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
import { CropStore } from '../crop/crop_store';
import { EditStore } from '../edit/edit_store';
import { KeystoneStore } from '../keystone/keystone_store';
import { RepairStore } from '../repair/repair_store';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import { StageStore } from '../stage/stage_store';

// The DOM first, then the library that reaches for it as it is imported. The alternative is a
// preload, which would install one for the server's suites too - they share this runner.
registerDom();
const { cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { kelvinAt, RawEditPanel, trackAt } = await import('../raw_edit_panel');
const { PrintStore } = await import('../print/print_store');
const { RawEditPanelStrings } = await import('../raw_edit_panel.strings');
const { TEMPERATURE_GREY_AT } = await import('../../../ui/slider');

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
    print: {},
  } as unknown as RawEditPresenter;
  return { presenter, calls };
}

function open(
  doc: Partial<ReturnType<typeof neutralEdits>> = {},
  asShot: { temperature: number; tint: number } | null = null,
  /// Set here rather than after the render: nothing but a presenter may write to a store once
  /// something is observing it, and MobX's strict mode says so.
  repreparing = false,
  status: StageStore['status'] = 'live',
  /// A measured fit by default, which is what every Bayer sensor's open reports. Null is the
  /// other kind of photograph: one whose pattern the denoise declines.
  noiseFit: StageStore['noiseFit'] = {
    alpha: 1,
    sigmaSq: 1,
    unifiedSigma: 1,
    darkRef: [0, 0, 0, 0],
  },
): {
  calls: { name: string; value: unknown }[];
  stage: StageStore;
  crop: CropStore;
} {
  const edit = new EditStore();
  const stage = new StageStore(edit);
  const crop = new CropStore(stage, edit);
  const keystone = new KeystoneStore(stage, edit, crop);
  const repair = new RepairStore(edit, keystone);
  edit.doc = { ...neutralEdits(), ...doc };
  stage.width = 4000;
  stage.height = 3000;
  stage.status = status;
  edit.asShot = asShot;
  stage.repreparing = repreparing;
  // What the open resolved the Detail pair to off this frame's fit, which is what the two rows
  // show where the document holds nothing. Distinct and off every fixed number the panel could
  // have fallen back to, so a row reading one of those fails here.
  stage.detail = [24, 76];
  stage.noiseFit = noiseFit;
  const { presenter, calls } = recording();
  render(
    <RawEditPanel
      edit={edit}
      stage={stage}
      crop={crop}
      keystone={keystone}
      repair={repair}
      print={new PrintStore()}
      presenter={presenter}
    />,
  );
  return { calls, stage, crop };
}

describe('the edit panel', () => {
  // The trim is a habit rather than an act now: it says whether the *next* straighten takes
  // the crop with it, so what the panel owes is the state and the way to turn it off.
  test('carries the crop-to-fit habit, and hands a change of it to the presenter', () => {
    const { calls, crop } = open();
    const check = screen.getByRole('checkbox', { name: 'Crop to fit' }) as HTMLInputElement;

    expect(crop.cropToFit).toBe(true);
    expect(check.checked).toBe(true);
    check.click();
    expect(calls).toEqual([{ name: 'setCropToFit', value: false }]);
  });

  // **The sliders would move and the picture would not.** GALOSH separates colour from luma over
  // one period of the pattern, so a sensor whose period does not hold all three colours is declined
  // outright and its frames come back with no fit measured. A reader is owed the reason rather than
  // two controls that do nothing - and the sharpen stays, because it inverts the capture's blur on
  // the warped frame and has nothing to do with the mosaic's pattern.
  test('drops the denoise pair, and says why, on a sensor the denoise declines', () => {
    open({}, null, false, 'live', null);
    expect(screen.queryByRole('slider', { name: 'Luminance' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Colour' })).toBeNull();
    expect(screen.getByText("Denoise unavailable for this camera's sensor")).not.toBeNull();
    expect(screen.getByRole('slider', { name: 'Sharpening' })).not.toBeNull();
  });

  test('keeps the denoise pair where the open measured a fit', () => {
    open();
    expect(screen.getByRole('slider', { name: 'Luminance' })).not.toBeNull();
    expect(screen.getByRole('slider', { name: 'Colour' })).not.toBeNull();
    expect(screen.queryByText("Denoise unavailable for this camera's sensor")).toBeNull();
  });

  // Nothing has been measured before the open finishes, which is not the same as nothing being
  // measurable - so the reason must not flash up on every photograph on its way in.
  test('says nothing about the denoise until the open has finished', () => {
    open({}, null, false, 'opening', null);
    expect(screen.getByRole('slider', { name: 'Luminance' })).not.toBeNull();
    expect(screen.queryByText("Denoise unavailable for this camera's sensor")).toBeNull();
  });

  test('shows the exposure in the document own unit', () => {
    open({ exposure: -1.5 });
    expect((screen.getByRole('textbox', { name: 'Exposure value' }) as HTMLInputElement).value).toBe('-1.50 EV');
  });

  test('settles a value typed finer than the slider steps', () => {
    const { calls } = open();
    const field = screen.getByRole('textbox', { name: 'Exposure value' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '0.333' } });
    fireEvent.blur(field);
    expect(calls).toEqual([{ name: 'settle', value: { exposure: 0.333 } }]);
  });

  test('closes the white balance pair on a file that records no neutral', () => {
    open();
    expect(screen.queryByRole('slider', { name: RawEditPanelStrings.temperature() })).toBeNull();
    expect(screen.getByRole('group', { name: 'White balance' }).textContent).toContain(
      'Camera white balance unavailable for this file',
    );
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
    expect((screen.getByLabelText('Reset Contrast') as HTMLButtonElement).disabled).toBe(true);
  });

  // Below the grade, and only what the proof can show: an sRGB rendition has its highlights to fit
  // and nothing else, a flat print has no light for a surface to catch, and the sheet has it all.
  test('adds what each soft proof can show below the edit panels', () => {
    for (const [proof, groups, absent] of [
      ['hdr', [], ['Tone mapping', 'Paper', 'Printer', 'Lighting']],
      ['srgb', ['Tone mapping'], ['Paper', 'Printer', 'Lighting']],
      ['print', ['Paper', 'Printer'], ['Tone mapping', 'Lighting', 'Rotation']],
      ['print3d', ['Paper', 'Printer', 'Lighting', 'Rotation'], ['Tone mapping']],
    ] as const) {
      const edit = new EditStore();
      const stage = new StageStore(edit);
      const crop = new CropStore(stage, edit);
      const keystone = new KeystoneStore(stage, edit, crop);
      const repair = new RepairStore(edit, keystone);
      const print = new PrintStore();
      edit.doc = neutralEdits();
      stage.status = 'live';
      stage.softProof = proof;
      print.open = proof === 'print' || proof === 'print3d';
      print.scene = { ...print.scene, presentation: proof === 'print' ? 'flat' : 'scene' };
      render(
        <RawEditPanel
          edit={edit}
          stage={stage}
          crop={crop}
          keystone={keystone}
          repair={repair}
          print={print}
          presenter={recording().presenter}
        />,
      );
      expect(screen.getByRole('group', { name: 'Light' })).not.toBeNull();
      for (const name of groups) expect(screen.getByRole('group', { name })).not.toBeNull();
      for (const name of absent) expect(screen.queryByRole('group', { name })).toBeNull();
      cleanup();
    }
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

  // **Settled rather than previewed, and that is the whole of what the switch owes.** Turning it
  // on is a re-prepare of the photograph off its mosaic, so it belongs with the release of a drag
  // rather than with the positions swept through on the way.
  test('hands the dust switch to the presenter as a settle', () => {
    // Off to start with, because what the switch owes is the transition, and a photograph opens
    // with this on.
    const { calls } = open({ dustRemoval: false });
    const check = screen.getByRole('checkbox', { name: 'Remove sensor dust' }) as HTMLInputElement;

    expect(check.checked).toBe(false);
    check.click();
    expect(calls).toEqual([{ name: 'settle', value: { dustRemoval: true } }]);
  });

  // The pair below the switch means nothing while it is off - there is no list of particles for a
  // confidence to cut or a depth to scale - so they are shut rather than left to do nothing.
  test('shuts the dust sliders until the switch is on', () => {
    const shut = (): boolean => (screen.getByRole('slider', { name: 'Sensitivity' }) as HTMLInputElement).disabled;

    open({ dustRemoval: false });
    expect(shut()).toBe(true);
    cleanup();

    // And a photograph nobody has touched opens with them live, because the switch starts on.
    open();
    expect(shut()).toBe(false);
  });

  // Only where something is actually in flight: a spinner on a group that is not rebuilding
  // anything is a reader waiting for a frame that already arrived.
  test('turns the mosaic groups spinner only while the picture is being rebuilt', () => {
    open({ dustRemoval: true });
    expect(screen.queryByRole('status', { name: 'Rebuilding the photo…' })).toBeNull();
    cleanup();

    open({ dustRemoval: true }, null, true);
    // Both mosaic groups say it, because a Detail slider costs exactly what a dust one does.
    expect(screen.getAllByRole('status', { name: 'Rebuilding the photo…' })).toHaveLength(2);
  });

  // The frame is seconds and the document is a small row, so the panel is the reader's own
  // settings from the moment they are read - shut, because nothing can act on them yet.
  test('shows the settings while the frame is still coming, with every control shut', () => {
    const { calls } = open({ contrast: 40 }, null, false, 'opening');

    const contrast = screen.getByRole('slider', { name: 'Contrast' }) as HTMLInputElement;
    expect(contrast.value).toBe('40');
    expect(within(screen.getByRole('group', { name: 'Light' })).getByText('+40')).toBeTruthy();
    expect(contrast.disabled).toBe(true);
    // The reset too, and it is the one that bites: a settle writes to the server, so a row
    // whose slider is greyed but whose arrow is not would save a photograph nobody has seen.
    screen.getByLabelText('Reset Contrast').click();
    expect(calls).toEqual([]);
    // And nothing claiming the file has no neutral: the illuminant is off a header that has
    // not arrived, which is not the same as a camera that recorded none.
    expect(screen.queryByText('Camera white balance unavailable for this file')).toBeNull();
  });

  // The three are separate: the bar runs from the zero point, the tick marks what a drag lands
  // on, and the reset arrow goes back to the photograph's own - which for the denoise pair are
  // all different, and the tick is the *measured* position rather than a fixed default.
  test('fills the denoise track from zero, and ticks it where the photograph puts it', () => {
    open({ colourNoise: 45 });

    // Neither mark has a role or a name, being drawing, so they are found inside the slider's own
    // group; the fill is the one with a width.
    const slider = screen.getByRole('slider', { name: 'Colour' }).closest<HTMLElement>('[role="group"]');
    const marks = [...(slider?.querySelectorAll<HTMLElement>('span[style]') ?? [])];
    const fill = marks.find((mark) => mark.style.width !== '');
    const tick = marks.find((mark) => mark.style.width === '');
    expect(fill?.style.left).toBe('0%');
    expect(fill?.style.width).toBe('45%');
    expect(tick?.style.left).toBe('76%');
  });

  // The document holds nothing for this pair until a reader moves it, so what the row shows is
  // what the decode resolved off the frame's own fit - and a fixed number here would be the page
  // stating a denoise the module never ran.
  test('shows the measured Detail where the document holds none', () => {
    const { calls } = open({ colourNoise: null, luminanceNoise: null });

    expect(screen.getByRole('slider', { name: 'Colour' }).getAttribute('aria-valuenow')).toBe('76');
    expect(screen.getByRole('slider', { name: 'Luminance' }).getAttribute('aria-valuenow')).toBe('24');
    const detail = within(screen.getByRole('group', { name: 'Detail' }));
    expect((detail.getByRole('textbox', { name: 'Colour value' }) as HTMLInputElement).value).toBe('76');
    expect((detail.getByRole('textbox', { name: 'Luminance value' }) as HTMLInputElement).value).toBe('24');
    // Untouched, so there is nothing to reset back to.
    screen.getByLabelText('Reset Colour').click();
    expect(calls).toEqual([]);
  });

  // Back to the photograph rather than back to a number: a reader who resets wants the answer to
  // keep following the frame, which a settled 76 would stop it doing on the next photograph.
  test('resets a moved Detail slider to nothing rather than to its measured value', () => {
    const { calls } = open({ colourNoise: 45 });

    screen.getByLabelText('Reset Colour').click();
    expect(calls).toEqual([{ name: 'settle', value: { colourNoise: null } }]);
  });
});

describe('the temperature track', () => {
  test('seats its three anchors at the ends and the middle', () => {
    expect(trackAt(2300)).toBeCloseTo(0, 10);
    expect(trackAt(5500)).toBeCloseTo(0.5, 10);
    expect(trackAt(50000)).toBeCloseTo(1, 10);
  });

  // The daylight anchor is held in two places and computed in neither: move it here and the paint
  // says a photograph balanced on the thumb has been warmed, over a picture nobody has touched.
  test('paints its grey where the daylight anchor stands', () => {
    expect(TEMPERATURE_GREY_AT).toBeCloseTo(trackAt(5500) * 100, 6);
  });

  // A drag landing on the snap has to give back the camera's own integer, or `previewBalance`
  // reads "Custom" - it compares with === - over a picture nobody has rebalanced.
  test('comes back as the Kelvin it went out as', () => {
    for (const kelvin of [2000, 2300, 5487, 6500, 50000, 60000]) {
      expect(Math.round(kelvinAt(trackAt(kelvin)))).toBe(kelvin);
    }
  });

  // 101 mireds against 33, so the warm end holding the longer piece of track is the direction a
  // reciprocal scale exists for. Linear in Kelvin it is 0.05, the cool end taking 21x the room.
  test('spends more of itself where the eye is sharper', () => {
    const warm = trackAt(3000) - trackAt(2300);
    const cool = trackAt(30000) - trackAt(15000);
    expect(warm / cool).toBeGreaterThan(1);
  });

  // The point of one curve over two straight halves, and asserted as shape rather than against a
  // tolerance: how fast a step grows climbs steadily the whole way across. Two mired-linear halves
  // would hold it flat either side and spike it 1.56x at the join, so the sequence would not climb.
  test('has no join in it', () => {
    const at = (n: number): number => kelvinAt(n / 200);
    const steps = Array.from({ length: 200 }, (_, n) => at(n + 1) - at(n));
    const growth = steps.slice(1).map((step, n) => step / (steps[n] as number));
    for (const [n, rate] of growth.slice(1).entries()) {
      expect(rate).toBeGreaterThan(growth[n] as number);
    }
  });
});
