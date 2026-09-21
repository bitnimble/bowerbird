// What the panel offers: a row per stage, a checkbox only on the ones a render can do without,
// and a cost beside each. The tab decides which rendition's list the checkboxes read, and what a
// stage costs is the machine's rather than this library's.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { type Library } from '../../../../../src/schemas/libraries';
import { type RenderTimings } from '../../../../../src/schemas/render_stages';
import { ESTIMATED_MS } from '../../../../../src/schemas/render_stages';
import { settingsApi } from '../../../api/settings';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { RenderStagesPanel } = await import('../render_stages_panel');
const { StoresProvider } = await import('../../../app/stores_context');

restoreApiAfterTests();
afterEach(cleanup);

const LIBRARY = {
  id: 'lib',
  name: 'Reef',
  root_path: '/nowhere/reef',
  render_skip_full: ['match'],
  render_skip_max: [],
} as unknown as Library;

beforeEach(() => {
  settingsApi.renderTimings = () => Promise.resolve({});
});

async function open(timings: RenderTimings = {}): Promise<void> {
  settingsApi.renderTimings = () => Promise.resolve(timings);
  render(
    <StoresProvider>
      <RenderStagesPanel library={LIBRARY} />
    </StoresProvider>,
  );
  await act(async () => {});
}

const ticked = (name: string): boolean => (screen.getByRole('checkbox', { name }) as HTMLInputElement).checked;

test('a stage a render cannot do without has a cost and nothing to press', async () => {
  await open();
  expect(screen.queryByRole('checkbox', { name: 'Reconstruct colour' })).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'Encode' })).toBeNull();
  expect(screen.getByText('Reconstruct colour')).toBeTruthy();
});

test('an unticked box is a stage this rendition leaves out', async () => {
  await open();
  expect(ticked("Match the camera's colour")).toBe(false);
  expect(ticked('Denoise')).toBe(true);
});

test('the other rendition reads its own list', async () => {
  await open();
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Rendered RAW (max quality)' }));
  });
  expect(ticked("Match the camera's colour")).toBe(true);
});

test('a stage quotes the estimate until this device has measured one', async () => {
  await open();
  expect(screen.getByText('Estimated')).toBeTruthy();
  expect(screen.getByText(`~${ESTIMATED_MS.full.match} ms`)).toBeTruthy();
});

test('a measurement displaces the estimate, and says so', async () => {
  await open({ full: { total: 900, stages: { match: 512 }, measured_at: new Date().toISOString() } });
  expect(screen.getByText(/^Measured /)).toBeTruthy();
  expect(screen.getByText('~512 ms')).toBeTruthy();
  // The rendition with nothing measured still quotes estimates, rather than the other tab's.
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Rendered RAW (max quality)' }));
  });
  expect(screen.getByText('Estimated')).toBeTruthy();
  expect(screen.getByText(`~${ESTIMATED_MS.max.match} ms`)).toBeTruthy();
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
