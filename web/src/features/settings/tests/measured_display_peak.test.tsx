// Where the shell reads the screen, Settings shows the peak it measured in place of the field.
import { afterEach, expect, test } from 'bun:test';
import type { DynamicRange } from '../../../api/transport';
import { ScreenPresenter } from '../../../app/screen_presenter';
import { screenStore } from '../../../app/screen_store';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { MeasuredDisplayPeak } = await import('../settings_page');
const { StoresProvider } = await import('../../../app/stores_context');

function measure(reading: DynamicRange | null): Promise<void> {
  return new ScreenPresenter(screenStore, async () => reading).ask();
}

afterEach(async () => {
  cleanup();
  await measure(null);
});

async function open(): Promise<void> {
  render(
    <StoresProvider>
      <MeasuredDisplayPeak />
    </StoresProvider>,
  );
  await act(async () => {});
}

test("shows the screen's measured peak, and follows it", async () => {
  await measure({ hdr: true, measures: true, headroom: 8, potential: 16 });
  await open();
  expect(screen.getByText('Display peak brightness')).toBeTruthy();
  expect(screen.getByText('1624 nits')).toBeTruthy();

  await act(() => measure({ hdr: true, measures: true, headroom: 4, potential: 16 }));
  expect(screen.getByText('812 nits')).toBeTruthy();
});

test('says when the screen has not opened its headroom yet', async () => {
  await measure({ hdr: true, measures: true, headroom: null, potential: 16 });
  await open();
  expect(screen.getByText('Measured while a photo is open')).toBeTruthy();
});

test('says SDR on a screen that shows nothing past SDR white', async () => {
  await measure({ hdr: false, measures: true, headroom: 1, potential: null });
  await open();
  expect(screen.getByText('SDR')).toBeTruthy();
});
