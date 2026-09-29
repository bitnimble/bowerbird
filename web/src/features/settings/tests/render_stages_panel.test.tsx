// What the panel offers: a row per stage, a checkbox only on the ones a render can do without,
// and a cost beside each. The tab decides which rendition's list the checkboxes read, and what a
// stage costs is the machine's rather than this library's.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type Library } from '../../../../../src/schemas/libraries';
import { type RenderTiming, type RenderTimings } from '../../../../../src/schemas/render_stages';
import { ESTIMATED_MS, ESTIMATED_PMRID_DENOISE_MS } from '../../../../../src/schemas/render_stages';
import { DEFAULT_SETTINGS } from '../../../../../src/schemas/settings';
import { settingsApi } from '../../../api/settings';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { RenderStagesPanel } = await import('../render_stages_panel');
const { StoresProvider, useAppSettingsStore } = await import('../../../app/stores_context');

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

function Harness({
  matchEmbeddedJpeg,
  library,
}: {
  matchEmbeddedJpeg: boolean;
  library: Library;
}): JSX.Element {
  const settings = useAppSettingsStore();
  useEffect(
    () =>
      runInAction(() => {
        settings.settings = { ...DEFAULT_SETTINGS, match_embedded_jpeg: matchEmbeddedJpeg };
      }),
    [matchEmbeddedJpeg, settings],
  );
  return <RenderStagesPanel library={library} />;
}

async function open(
  timings: RenderTimings = {},
  matchEmbeddedJpeg = true,
  library = LIBRARY,
): Promise<void> {
  settingsApi.renderTimings = () => Promise.resolve(timings);
  render(
    <StoresProvider>
      <Harness matchEmbeddedJpeg={matchEmbeddedJpeg} library={library} />
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

test('a stage a render cannot do without has a cost and nothing to press', async () => {
  await open();
  expect(screen.queryByRole('checkbox', { name: 'Reconstruct colour' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Encode' })).toBeNull();
  expect(screen.getByText('Reconstruct colour')).toBeTruthy();
});

test('an unticked box is a stage this rendition leaves out', async () => {
  await open();
  expect(ticked('Match lens')).toBe(false);
  expect(ticked('Match camera colour')).toBe(false);
  expect(
    screen.getByRole('checkbox', { name: 'Match camera colour' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(ticked('Denoise')).toBe(true);
});

test('encode includes the grade and a measured zero states the measurement limit', async () => {
  await open({ full: { galosh: measuredNow({ denoise: 0, defringe: 0 }) } });
  expect(screen.queryByText('Colour grade')).toBeNull();
  expect(screen.getByText('~188 ms')).toBeTruthy();
  expect(screen.getAllByText('No measurable saving')).toHaveLength(2);
});

test('the other rendition reads its own list', async () => {
  await open();
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Rendered RAW (max quality)' }));
  });
  expect(ticked('Match lens')).toBe(true);
  expect(ticked('Match camera colour')).toBe(true);
  expect(
    screen.getByRole('checkbox', { name: 'Match camera colour' }).hasAttribute('disabled'),
  ).toBe(false);
});

test('global camera matching off shows both dependent stages inactive', async () => {
  await open({}, false);
  for (const name of ['Match lens', 'Match camera colour']) {
    const checkbox = screen.getByRole('checkbox', { name }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText(name).parentElement?.getAttribute('aria-description')).toBe(
      'Camera matching is off in Advanced settings',
    );
  }
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
  // The rendition with nothing measured still quotes estimates, rather than the other tab's.
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Rendered RAW (max quality)' }));
  });
  expect(screen.getByText('Estimated')).toBeTruthy();
  expect(screen.getByText(`~${ESTIMATED_MS.max.colour} ms`)).toBeTruthy();
});

test("a library on the other denoiser quotes that denoiser's cost, and measures with it", async () => {
  const runs: string[] = [];
  settingsApi.benchmarkRender = (rendition, denoiser) => {
    runs.push(`${rendition} ${denoiser}`);
    return Promise.resolve(measuredNow({ denoise: 77 }));
  };
  // A GALOSH measurement says nothing about what PMRID costs here.
  await open({ full: { galosh: measuredNow({ denoise: 5 }) } }, true, {
    ...LIBRARY,
    denoiser: 'pmrid',
  });
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
