// What the panel offers: a checkbox and a cost for each stage a `full` render can do without, and
// one Misc row for the rest. What a stage costs is the machine's rather than a library's.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { DEFAULT_LIBRARY_SETTINGS, type Library } from '../../../../../src/schemas/libraries';
import { type RenderTiming, type RenderTimings } from '../../../../../src/schemas/render_stages';
import { ESTIMATED_MS, ESTIMATED_PMRID_DENOISE_MS } from '../../../../../src/schemas/render_stages';
import { DEFAULT_SETTINGS } from '../../../../../src/schemas/settings';
import { librariesApi } from '../../../api/libraries';
import { settingsApi } from '../../../api/settings';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { RenderStagesPanel } = await import('../render_stages_panel');
const { StoresProvider, useAppSettingsStore, useLibrariesStore } =
  await import('../../../app/stores_context');

restoreApiAfterTests();
afterEach(cleanup);

const LIBRARY = {
  id: 'lib',
  name: 'Reef',
  root_path: '/nowhere/reef',
  render_skip_full: ['lens', 'colour'],
  render_skip_max: [],
  denoiser: 'galosh',
} as unknown as Library;

beforeEach(() => {
  settingsApi.renderTimings = () => Promise.resolve({});
});

function Harness({ libraries }: { libraries: Library[] }): JSX.Element {
  const settings = useAppSettingsStore();
  const store = useLibrariesStore();
  useEffect(
    () =>
      runInAction(() => {
        settings.settings = DEFAULT_SETTINGS;
        store.libraries = libraries;
        store.defaults = DEFAULT_LIBRARY_SETTINGS;
      }),
    [settings, store, libraries],
  );
  return <RenderStagesPanel />;
}

async function open(timings: RenderTimings = {}, libraries = [LIBRARY]): Promise<void> {
  settingsApi.renderTimings = () => Promise.resolve(timings);
  render(
    <StoresProvider>
      <Harness libraries={libraries} />
    </StoresProvider>,
  );
  await act(async () => {});
}

const measuredNow = (stages: RenderTiming['stages']): RenderTiming => ({
  total: 900,
  stages,
  measured_at: new Date().toISOString(),
});

const ticked = (name: string): boolean =>
  (screen.getByRole('checkbox', { name }) as HTMLInputElement).checked;

test('the stages a render cannot do without share one Misc row with nothing to press', async () => {
  await open();
  expect(screen.queryByRole('checkbox', { name: 'Misc' })).toBeNull();
  const { read, demosaic, encode } = ESTIMATED_MS.full;
  expect(screen.getByText('Misc').parentElement?.textContent).toBe(
    `Misc~${read + demosaic + encode} ms`,
  );
});

test('an unticked box is a stage the full rendition leaves out', async () => {
  await open();
  expect(ticked('Correct lens distortion')).toBe(false);
  expect(ticked('Auto-detect camera colour profile')).toBe(false);
  expect(
    screen
      .getByRole('checkbox', { name: 'Auto-detect camera colour profile' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(ticked('Denoise')).toBe(true);
});

test('a measured zero states the measurement limit', async () => {
  await open({ full: { galosh: measuredNow({ denoise: 0, defringe: 0 }) } });
  expect(screen.getAllByText('No measurable saving')).toHaveLength(2);
});

test('only the full rendition is offered', async () => {
  await open();
  expect(screen.queryByRole('radio', { name: 'Rendered RAW (max quality)' })).toBeNull();
  expect(screen.queryByRole('radiogroup')).toBeNull();
});

test('the total is what the stages this rendition runs cost together', async () => {
  const stages = {
    read: 10,
    dust: 20,
    denoise: 30,
    demosaic: 40,
    lens: 1000,
    colour: 2000,
    defringe: 50,
    sharpen: 60,
    encode: 70,
  };
  await open({ full: { galosh: measuredNow(stages) } });
  // `full` leaves out the lens and the colour match.
  expect(screen.getByText('Total').parentElement?.textContent).toBe('Total~280 ms');
  expect(screen.getByText('Misc').parentElement?.textContent).toBe('Misc~120 ms');
});

test('a stage quotes the estimate until this device has measured one', async () => {
  await open();
  expect(screen.getByText('Estimated')).toBeTruthy();
  expect(screen.getByText(`~${ESTIMATED_MS.full.colour} ms`)).toBeTruthy();
});

test('a measurement displaces the estimate, and says so', async () => {
  await open({ full: { galosh: measuredNow({ colour: 512 }) } });
  expect(screen.getByText(/^Measured /)).toBeTruthy();
  expect(screen.getByText('~512 ms')).toBeTruthy();
});

test("a library on the other denoiser quotes that denoiser's cost, and measures with it", async () => {
  const runs: string[] = [];
  settingsApi.benchmarkRender = (rendition, denoiser) => {
    runs.push(`${rendition} ${denoiser}`);
    return Promise.resolve(measuredNow({ denoise: 77 }));
  };
  // A GALOSH measurement says nothing about what PMRID costs here.
  await open({ full: { galosh: measuredNow({ denoise: 5 }) } }, [
    { ...LIBRARY, denoiser: 'pmrid' },
  ]);
  expect(screen.getByText('Estimated')).toBeTruthy();
  expect(screen.getByText(`~${ESTIMATED_PMRID_DENOISE_MS} ms`)).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Denoiser' }).textContent).toContain(
    'Quality (PMRID)',
  );

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Measure' }));
  });
  expect(runs).toEqual(['full pmrid']);
  expect(screen.getByText('~77 ms')).toBeTruthy();
});

test('it shows the first library and a tick goes to all of them', async () => {
  const asked: Record<string, unknown> = {};
  librariesApi.update = (id, body) => {
    asked[id] = body;
    return Promise.resolve(LIBRARY);
  };
  librariesApi.list = () => Promise.reject(new Error('unused'));
  librariesApi.getDefaults = () => Promise.reject(new Error('unused'));
  const second: Library = { ...LIBRARY, id: 'second', render_skip_full: ['dust'] };
  await open({}, [LIBRARY, second]);

  expect(ticked('Correct lens distortion')).toBe(false);
  expect(ticked('Dust removal')).toBe(true);

  await act(async () => {
    fireEvent.click(screen.getByRole('checkbox', { name: 'Denoise' }));
  });

  expect(asked).toEqual({
    lib: { render_skip_full: ['denoise', 'lens', 'colour'] },
    second: { render_skip_full: ['dust', 'denoise'] },
  });
});

test('with no libraries it shows the defaults and nothing can be changed', async () => {
  await open({}, []);

  for (const checkbox of screen.getAllByRole('checkbox') as HTMLInputElement[]) {
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
  }
  const denoiser = screen.getByRole('combobox', { name: 'Denoiser' });
  expect(denoiser.textContent).toContain('Fast (GALOSH)');
  expect(denoiser.hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Dust removal').parentElement?.getAttribute('aria-description')).toBe(
    'Add a library to change this',
  );
  expect(screen.getByText('Misc').parentElement?.getAttribute('aria-description')).toBeNull();
  expect(screen.getByRole('button', { name: 'Measure' }).hasAttribute('disabled')).toBe(false);
});

test('the button says it is working and refuses a second run while one is in flight', async () => {
  let finish = (): void => {};
  const runs: string[] = [];
  settingsApi.benchmarkRender = (rendition) => {
    runs.push(rendition);
    return new Promise((resolve) => {
      finish = () => resolve({ total: 1, stages: {}, measured_at: new Date().toISOString() });
    });
  };
  await open();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Measure' }));
  });
  const measuring = screen.getByRole('button', { name: 'Measuring…' });
  expect(measuring.getAttribute('aria-busy')).toBe('true');

  // A second press while it is running must not start a second render of the same thing.
  await act(async () => {
    fireEvent.click(measuring);
  });
  expect(runs).toEqual(['full']);

  await act(async () => {
    finish();
  });
  expect(screen.getByRole('button', { name: 'Measure' })).toBeTruthy();
});
