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
import { runInAction } from 'mobx';
import { neutralEdits } from '../../../../../src/schemas/photo_edits';
import { registerDom } from '../../../test_dom';
import { CropStore } from '../crop/crop_store';
import { EditStore } from '../edit/edit_store';
import { KeystoneStore } from '../keystone/keystone_store';
import { RepairStore } from '../repair/repair_store';
import { ReflectionStore } from '../reflection/reflection_store';
import { ColourWheelStore } from '../colour_wheel/colour_wheel_store';
import type { RawEditPresenter } from '../stage/raw_edit_presenter';
import { StageStore } from '../stage/stage_store';

// The DOM first, then the library that reaches for it as it is imported. The alternative is a
// preload, which would install one for the server's suites too - they share this runner.
registerDom();
const { act, cleanup, fireEvent, render, screen, within } = await import('@testing-library/react');
const { kelvinAt, RawEditPanel, trackAt } = await import('../raw_edit_panel');
const { PrintStore } = await import('../print/print_store');
const { StoresProvider, useUpdatesStore } = await import('../../../app/stores_context');
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
    reflection: {
      setEnabled: record('reflection.setEnabled'),
      setBrushing: record('reflection.setBrushing'),
      setMode: record('reflection.setMode'),
      setSize: record('reflection.setSize'),
      clear: record('reflection.clear'),
    },
    print: {},
    colourWheel: { key: 'wheel', attach: () => {} },
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
  mosaic = true,
  upscalable = true,
  softProof: StageStore['softProof'] = 'hdr',
  brushing = false,
  models: Models | null = HELD,
  info: React.ReactNode = null,
): {
  calls: { name: string; value: unknown }[];
  stage: StageStore;
  crop: CropStore;
  print: InstanceType<typeof PrintStore>;
} {
  const edit = new EditStore();
  const stage = new StageStore(edit);
  const crop = new CropStore(stage, edit);
  const keystone = new KeystoneStore(stage, edit, crop);
  const repair = new RepairStore(edit, keystone);
  const reflection = new ReflectionStore(edit, stage);
  reflection.brushing = brushing;
  edit.doc = { ...neutralEdits(), ...doc };
  stage.width = 4000;
  stage.height = 3000;
  stage.status = status;
  edit.asShot = asShot;
  stage.repreparing = repreparing;
  // What the open resolved the Detail pair to off this frame's fit, which is what the two rows
  // show where the document holds nothing. Distinct and off every fixed number the panel could
  // have fallen back to, so a row reading one of those fails here.
  stage.detail = status === 'live' ? [24, 76] : null;
  stage.noiseFit = noiseFit;
  stage.mosaic = mosaic;
  edit.upscalable = upscalable;
  stage.softProof = softProof;
  const print = new PrintStore();
  const { presenter, calls } = recording();
  render(
    <StoresProvider>
      <WithModels models={models}>
        <RawEditPanel
          edit={edit}
          stage={stage}
          crop={crop}
          keystone={keystone}
          repair={repair}
          reflection={reflection}
          colourWheel={new ColourWheelStore(edit)}
          print={print}
          presenter={presenter}
          info={info}
        />
      </WithModels>
    </StoresProvider>,
  );
  return { calls, stage, crop, print };
}

/** The server's models as the updates check found them: the files in use, and whether a newer commit is on offer. */
type Models = { files: string[]; newer: boolean; error: string | null; downloading?: boolean };
const HELD: Models = {
  files: ['upscaler.json', 'upscaler.bin', 'dereflect.json', 'dereflect.bin'],
  newer: false,
  error: null,
};
const WITHOUT_REMOVER = ['upscaler.json', 'upscaler.bin'];

function WithModels({
  models,
  children,
}: {
  models: Models | null;
  children: JSX.Element;
}): JSX.Element {
  const updates = useUpdatesStore();
  runInAction(() => {
    if (models == null) {
      updates.models = null;
      return;
    }
    updates.models = {
      current: {
        revision: 'held',
        committed_at: '2026-10-26T00:00:00.000Z',
        downloaded: true,
        files: models.files,
      },
      available: models.newer
        ? { revision: 'newer', committed_at: '2026-10-27T00:00:00.000Z', bytes: 154_000_000 }
        : null,
      downloading: false,
      checked_at: null,
      error: null,
    };
    updates.modelsFailure = models.error;
    updates.modelsDownloading = models.downloading ?? false;
  });
  return children;
}

function showTab(name: string): void {
  act(() => fireEvent.click(screen.getByRole('tab', { name })));
}

describe('the edit panel', () => {
  test('shows only the chosen tab, Light first', () => {
    open();
    expect(screen.getByRole('tab', { name: 'Light', selected: true })).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Light' })).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'White balance' })).toBeNull();

    showTab('Colour');
    expect(screen.queryByRole('group', { name: 'Light' })).toBeNull();
    expect(screen.getByRole('group', { name: 'White balance' })).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Colour' })).not.toBeNull();
  });

  test('hands the chosen tab back once a tool lets go of the panel', () => {
    const { crop } = open();
    showTab('Geometry');

    act(() => runInAction(() => (crop.cropping = true)));
    expect(screen.queryByRole('tab')).toBeNull();
    act(() => runInAction(() => (crop.cropping = false)));
    expect(screen.getByRole('tab', { name: 'Geometry', selected: true })).not.toBeNull();
  });

  test('selects the soft proof tab when a proof is chosen, and Light once it is gone', () => {
    const { stage } = open();
    showTab('Detail');

    act(() => runInAction(() => (stage.softProof = 'srgb')));
    expect(screen.getByRole('tab', { name: 'Soft proof', selected: true })).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Tone mapping' })).not.toBeNull();

    act(() => runInAction(() => (stage.softProof = 'hdr')));
    expect(screen.queryByRole('tab', { name: 'Soft proof' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Light', selected: true })).not.toBeNull();
  });

  test('selects the soft proof tab again when another proof is chosen', () => {
    const { stage, print } = open();
    act(() => runInAction(() => (stage.softProof = 'srgb')));
    showTab('Light');

    act(() =>
      runInAction(() => {
        stage.softProof = 'print';
        print.open = true;
      }),
    );
    expect(screen.getByRole('tab', { name: 'Soft proof', selected: true })).not.toBeNull();
    expect(screen.getByRole('group', { name: 'Paper' })).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'Tone mapping' })).toBeNull();
  });

  test('offers no Info tab without info to show', () => {
    open();
    expect(screen.queryByRole('tab', { name: 'Info' })).toBeNull();
  });

  test('shows the info in its own tab, ahead of the soft proof', () => {
    const { stage } = open(
      {},
      null,
      false,
      'live',
      undefined,
      true,
      true,
      'hdr',
      false,
      HELD,
      <p>Camera details</p>,
    );
    act(() => runInAction(() => (stage.softProof = 'srgb')));
    expect(
      screen.getAllByRole('tab').map((tab) => tab.getAttribute('aria-label') ?? tab.textContent),
    ).toEqual([
      'Light',
      'Colour',
      'Effects',
      'Detail',
      'Retouch',
      'Geometry',
      'Info',
      'Soft proof',
    ]);
    expect(screen.queryByText('Camera details')).toBeNull();

    showTab('Info');
    expect(screen.getByText('Camera details')).not.toBeNull();
    expect(screen.queryByRole('group', { name: 'Tone mapping' })).toBeNull();
  });

  test('opens on Light when a proof is already in force', () => {
    open({}, null, false, 'live', undefined, true, true, 'srgb');
    expect(screen.getByRole('tab', { name: 'Light', selected: true })).not.toBeNull();
    expect(screen.getByRole('tab', { name: 'Soft proof', selected: false })).not.toBeNull();
  });

  // The trim is a habit rather than an act now: it says whether the *next* straighten takes
  // the crop with it, so what the panel owes is the state and the way to turn it off.
  test('carries the crop-to-fit habit, and hands a change of it to the presenter', () => {
    const { calls, crop } = open();
    showTab('Geometry');
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
    showTab('Detail');
    expect(screen.queryByRole('slider', { name: 'Luminance' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Colour' })).toBeNull();
    expect(screen.getByText("Denoise unavailable for this camera's sensor")).not.toBeNull();
    expect(screen.getByRole('slider', { name: 'Highlight recovery' })).not.toBeNull();
    expect(screen.getByRole('slider', { name: 'Sharpening' })).not.toBeNull();
  });

  test('drops every mosaic slider but the sharpen on a developed photo', () => {
    open({}, null, false, 'live', undefined, false);
    showTab('Detail');
    expect(screen.queryByRole('slider', { name: 'Luminance' })).toBeNull();
    expect(screen.queryByRole('slider', { name: 'Highlight recovery' })).toBeNull();
    expect(
      screen.getByText('Denoise and highlight recovery unavailable for developed photos'),
    ).not.toBeNull();
    expect(screen.getByRole('slider', { name: 'Sharpening' })).not.toBeNull();
  });

  test('keeps the denoise pair where the open measured a fit', () => {
    open();
    showTab('Detail');
    expect(screen.getByRole('slider', { name: 'Luminance' })).not.toBeNull();
    expect(screen.getByRole('slider', { name: 'Colour' })).not.toBeNull();
    expect(screen.queryByText("Denoise unavailable for this camera's sensor")).toBeNull();
  });

  // Nothing has been measured before the open finishes, which is not the same as nothing being
  // measurable - so the reason must not flash up on every photograph on its way in.
  test('says nothing about the denoise until the open has finished', () => {
    open({}, null, false, 'opening', null);
    showTab('Detail');
    expect(screen.getByRole('slider', { name: 'Luminance' })).not.toBeNull();
    expect(screen.queryByText("Denoise unavailable for this camera's sensor")).toBeNull();
  });

  test('shows the exposure in the document own unit', () => {
    open({ exposure: -1.5 });
    expect(
      (screen.getByRole('textbox', { name: 'Exposure value' }) as HTMLInputElement).value,
    ).toBe('-1.50 EV');
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
    showTab('Colour');
    expect(screen.queryByRole('slider', { name: RawEditPanelStrings.temperature() })).toBeNull();
    expect(screen.getByRole('group', { name: 'White balance' }).textContent).toContain(
      'Camera white balance unavailable for this file',
    );
  });

  // The reader gets back to neutral without hunting for the number: the sliders cannot be
  // driven here (see the note at the top), so what is asserted is the button beside them.
  test('puts a moved parameter back where it started', () => {
    const { calls } = open({ highlights: 40 });

    screen.getByLabelText('Reset Highlights').click();
    expect(calls).toEqual([{ name: 'settle', value: { highlights: 0 } }]);
  });

  test('shows the exposure and saturation the camera match wrote, and resets them to 0', () => {
    const { calls } = open({ exposure: 0.35, saturation: 17 });
    const light = within(screen.getByRole('group', { name: 'Light' }));
    expect((light.getByRole('textbox', { name: 'Exposure value' }) as HTMLInputElement).value).toBe(
      '+0.35 EV',
    );
    screen.getByLabelText('Reset Exposure').click();

    showTab('Colour');
    expect(
      (screen.getByRole('textbox', { name: 'Saturation value' }) as HTMLInputElement).value,
    ).toBe('+17');
    screen.getByLabelText('Reset Saturation').click();
    expect(calls).toEqual([
      { name: 'settle', value: { exposure: 0 } },
      { name: 'settle', value: { saturation: 0 } },
    ]);
  });

  test('offers nothing to reset on exposure and saturation at 0', () => {
    open();
    expect((screen.getByLabelText('Reset Exposure') as HTMLButtonElement).disabled).toBe(true);
    showTab('Colour');
    expect((screen.getByLabelText('Reset Saturation') as HTMLButtonElement).disabled).toBe(true);
  });

  test('shuts the exposure until the header arrives', () => {
    open({}, null, false, 'opening');
    expect(screen.queryByRole('textbox', { name: 'Exposure value' })).toBeNull();
    expect((screen.getByRole('slider', { name: 'Exposure' }) as HTMLInputElement).disabled).toBe(
      true,
    );
  });

  test('offers nothing to reset on a parameter nobody has moved', () => {
    open();
    expect((screen.getByLabelText('Reset Contrast') as HTMLButtonElement).disabled).toBe(true);
  });

  // Only what the proof can show: an sRGB rendition has its highlights to fit and nothing else, a
  // flat print has no light for a surface to catch, and the sheet has it all.
  test('adds a tab of what each soft proof can show', () => {
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
          reflection={new ReflectionStore(edit, stage)}
          colourWheel={new ColourWheelStore(edit)}
          print={print}
          presenter={recording().presenter}
        />,
      );
      expect(screen.getByRole('group', { name: 'Light' })).not.toBeNull();
      if (groups.length === 0) expect(screen.queryByRole('tab', { name: 'Soft proof' })).toBeNull();
      else showTab('Soft proof');
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
    showTab('Colour');

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
    showTab('Detail');
    const check = screen.getByRole('checkbox', { name: 'Remove sensor dust' }) as HTMLInputElement;

    expect(check.checked).toBe(false);
    check.click();
    expect(calls).toEqual([{ name: 'settle', value: { dustRemoval: true } }]);
  });

  // The pair below the switch means nothing while it is off - there is no list of particles for a
  // confidence to cut or a depth to scale - so they are shut rather than left to do nothing.
  test('shuts the dust sliders until the switch is on', () => {
    const shut = (): boolean =>
      (screen.getByRole('slider', { name: 'Sensitivity' }) as HTMLInputElement).disabled;

    open({ dustRemoval: false });
    showTab('Detail');
    expect(shut()).toBe(true);
    cleanup();

    // And a photograph nobody has touched opens with them live, because the switch starts on.
    open();
    showTab('Detail');
    expect(shut()).toBe(false);
  });

  // Only where something is actually in flight: a spinner on a group that is not rebuilding
  // anything is a reader waiting for a frame that already arrived.
  test('turns the mosaic groups spinner only while the picture is being rebuilt', () => {
    open({ dustRemoval: true });
    showTab('Detail');
    expect(screen.queryByRole('status', { name: 'Rebuilding the photo…' })).toBeNull();
    cleanup();

    open({ dustRemoval: true }, null, true);
    showTab('Detail');
    // Both mosaic groups say it, because a Detail slider costs exactly what a dust one does.
    expect(screen.getAllByRole('status', { name: 'Rebuilding the photo…' })).toHaveLength(2);
  });

  describe('reflection removal', () => {
    const shut = (role: 'slider' | 'button', name: string): boolean =>
      (screen.getByRole(role, { name }) as HTMLInputElement | HTMLButtonElement).disabled;

    test('sits under Retouch, its switch handed to the presenter', () => {
      const { calls } = open();
      showTab('Retouch');
      expect(screen.getByRole('group', { name: 'Reflection removal' })).not.toBeNull();
      const check = screen.getByRole('checkbox', {
        name: 'Remove reflections',
      }) as HTMLInputElement;

      expect(check.checked).toBe(false);
      check.click();
      expect(calls).toEqual([{ name: 'reflection.setEnabled', value: true }]);
    });

    test('shuts the strength and the brush until the switch is on', () => {
      open();
      showTab('Retouch');
      expect(shut('slider', 'Strength')).toBe(true);
      expect(shut('button', 'Brush')).toBe(true);
      expect(shut('slider', 'Size')).toBe(true);
      cleanup();

      open({ reflectionRemoval: true });
      showTab('Retouch');
      expect(shut('slider', 'Strength')).toBe(false);
      expect(shut('button', 'Brush')).toBe(false);
      expect(shut('slider', 'Size')).toBe(false);
    });

    test('turns the brush on as a pressed button, and off when its tab is left', () => {
      const { calls } = open({ reflectionRemoval: true });
      showTab('Retouch');
      const brush = screen.getByRole('button', { name: 'Brush' });
      expect(brush.getAttribute('aria-pressed')).toBe('false');
      brush.click();
      expect(calls).toEqual([{ name: 'reflection.setBrushing', value: true }]);
      cleanup();

      const brushing = open(
        { reflectionRemoval: true },
        null,
        false,
        'live',
        undefined,
        true,
        true,
        'hdr',
        true,
      );
      showTab('Retouch');
      expect(screen.getByRole('button', { name: 'Brush' }).getAttribute('aria-pressed')).toBe(
        'true',
      );
      showTab('Light');
      expect(brushing.calls).toEqual([{ name: 'reflection.setBrushing', value: false }]);
    });

    test('chooses what a stroke marks', () => {
      const { calls } = open({ reflectionRemoval: true });
      showTab('Retouch');
      const modes = screen.getByRole('radiogroup', { name: 'Brush mode' });
      expect(
        within(modes).getByRole('radio', { name: 'Remove' }).getAttribute('aria-checked'),
      ).toBe('true');
      act(() => within(modes).getByRole('radio', { name: 'Keep' }).click());
      expect(calls).toEqual([{ name: 'reflection.setMode', value: 'keep' }]);
    });

    test('clears strokes only once there are some', () => {
      open({ reflectionRemoval: true });
      showTab('Retouch');
      expect(shut('button', 'Clear strokes')).toBe(true);
      cleanup();

      const { calls } = open({
        reflectionRemoval: true,
        reflectionStrokes: [{ kind: 'remove', radius: 3000, points: [[100, 200]] }],
      });
      showTab('Retouch');
      screen.getByRole('button', { name: 'Clear strokes' }).click();
      expect(calls.map(({ name }) => name)).toEqual(['reflection.clear']);
    });

    const withModels = (
      doc: Partial<ReturnType<typeof neutralEdits>>,
      models: Models | null,
    ): void => {
      open(doc, null, false, 'live', undefined, true, true, 'hdr', false, models);
      showTab('Retouch');
    };
    const switchShut = (): boolean =>
      (screen.getByRole('checkbox', { name: 'Remove reflections' }) as HTMLInputElement).disabled;

    test('turns on only once the models hold it, and offers the update that does', () => {
      withModels({}, { files: WITHOUT_REMOVER, newer: true, error: null });
      expect(screen.getByText('Reflection removal needs an AI models update.')).not.toBeNull();
      expect(shut('button', 'Update AI models')).toBe(false);
      expect(switchShut()).toBe(true);
    });

    test('stays open while the updates check has not answered', () => {
      withModels({}, null);
      expect(switchShut()).toBe(false);
      expect(screen.queryByText('Reflection removal needs an AI models update.')).toBeNull();
    });

    test('holds the update button while the models download', () => {
      withModels({}, { files: WITHOUT_REMOVER, newer: true, error: null, downloading: true });
      expect(shut('button', 'Update AI models')).toBe(true);
    });

    test('says why there is nothing to update to', () => {
      withModels({}, { files: WITHOUT_REMOVER, newer: false, error: 'offline' });
      expect(screen.getByText("We couldn't check for AI models.")).not.toBeNull();
      expect(screen.queryByRole('button', { name: 'Update AI models' })).toBeNull();
      cleanup();

      withModels({}, { files: WITHOUT_REMOVER, newer: false, error: null });
      expect(
        screen.getByText("The AI models for reflection removal aren't available yet."),
      ).not.toBeNull();
    });

    // A document synced from a device that has the models.
    test('turns off and clears without the models', () => {
      withModels(
        {
          reflectionRemoval: true,
          reflectionStrokes: [{ kind: 'remove', radius: 3000, points: [[100, 200]] }],
        },
        { files: WITHOUT_REMOVER, newer: false, error: null },
      );
      expect(switchShut()).toBe(false);
      expect(shut('button', 'Clear strokes')).toBe(false);
    });

    test('is unavailable for merged and developed photos', () => {
      open({}, null, false, 'live', undefined, false);
      showTab('Retouch');
      expect(
        screen.getByText('Reflection removal unavailable for merged or developed photos'),
      ).not.toBeNull();
      expect(screen.queryByRole('checkbox', { name: 'Remove reflections' })).toBeNull();
    });

    test('turns its spinner only while the picture is being rebuilt', () => {
      open({ reflectionRemoval: true });
      showTab('Retouch');
      expect(screen.queryByRole('status', { name: 'Rebuilding the photo…' })).toBeNull();
      cleanup();

      open({ reflectionRemoval: true }, null, true);
      showTab('Retouch');
      expect(screen.getAllByRole('status', { name: 'Rebuilding the photo…' })).toHaveLength(1);
    });
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
    showTab('Colour');
    expect(screen.getByRole('group', { name: 'White balance' })).not.toBeNull();
    expect(screen.queryByText('Camera white balance unavailable for this file')).toBeNull();
  });

  // The three are separate: the bar runs from the zero point, the tick marks what a drag lands
  // on, and the reset arrow goes back to the photograph's own - which for the denoise pair are
  // all different, and the tick is the *measured* position rather than a fixed default.
  test('fills the denoise track from zero, and ticks it where the photograph puts it', () => {
    open({ colourNoise: 45 });
    showTab('Detail');

    // Neither mark has a role or a name, being drawing, so they are found inside the slider's own
    // group; the fill is the one with a width.
    const slider = screen
      .getByRole('slider', { name: 'Colour' })
      .closest<HTMLElement>('[role="group"]');
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
    showTab('Detail');

    expect(screen.getByRole('slider', { name: 'Colour' }).getAttribute('aria-valuenow')).toBe('76');
    expect(screen.getByRole('slider', { name: 'Luminance' }).getAttribute('aria-valuenow')).toBe(
      '24',
    );
    const detail = within(screen.getByRole('group', { name: 'Detail' }));
    expect((detail.getByRole('textbox', { name: 'Colour value' }) as HTMLInputElement).value).toBe(
      '76',
    );
    expect(
      (detail.getByRole('textbox', { name: 'Luminance value' }) as HTMLInputElement).value,
    ).toBe('24');
    // Untouched, so there is nothing to reset back to.
    screen.getByLabelText('Reset Colour').click();
    expect(calls).toEqual([]);
  });

  // Back to the photograph rather than back to a number: a reader who resets wants the answer to
  // keep following the frame, which a settled 76 would stop it doing on the next photograph.
  test('resets a moved Detail slider to nothing rather than to its measured value', () => {
    const { calls } = open({ colourNoise: 45 });
    showTab('Detail');

    screen.getByLabelText('Reset Colour').click();
    expect(calls).toEqual([{ name: 'settle', value: { colourNoise: null } }]);
  });

  test("shows the denoiser's sharpening where the document holds none", () => {
    const { calls } = open({ denoiser: 'upscaler', sharpening: null });
    showTab('Detail');

    const sharpening = screen.getByRole('slider', { name: 'Sharpening' });
    expect(sharpening.getAttribute('aria-valuenow')).toBe('35');
    screen.getByLabelText('Reset Sharpening').click();
    expect(calls).toEqual([]);
    cleanup();

    open({ denoiser: 'galosh', sharpening: null });
    showTab('Detail');
    expect(screen.getByRole('slider', { name: 'Sharpening' }).getAttribute('aria-valuenow')).toBe(
      '50',
    );
  });

  test('offers the upscaler only over a Bayer mosaic, and shows what runs in its place', () => {
    const picker = (): HTMLElement =>
      screen.getByRole('combobox', { name: RawEditPanelStrings.denoiser() });
    const best = (): HTMLElement => {
      fireEvent.click(picker());
      return screen.getByRole('option', { name: RawEditPanelStrings.denoiserUpscaler() });
    };
    open({ denoiser: 'upscaler' });
    showTab('Detail');
    expect(picker().textContent).toContain(RawEditPanelStrings.denoiserUpscaler());
    expect(best().getAttribute('aria-disabled')).toBeNull();
    cleanup();

    open({ denoiser: 'upscaler' }, null, false, 'live', undefined, true, false);
    showTab('Detail');
    expect(picker().textContent).toContain(RawEditPanelStrings.denoiserGalosh());
    const option = best();
    expect(option.getAttribute('aria-disabled')).toBe('true');
    expect(option.getAttribute('aria-description')).toBe(
      RawEditPanelStrings.denoiserUpscalerUnavailable(),
    );
  });

  test("resets a moved sharpening to nothing, so it follows the denoiser's default again", () => {
    const { calls } = open({ denoiser: 'upscaler', sharpening: 60 });
    showTab('Detail');

    screen.getByLabelText('Reset Sharpening').click();
    expect(calls).toEqual([{ name: 'settle', value: { sharpening: null } }]);
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
