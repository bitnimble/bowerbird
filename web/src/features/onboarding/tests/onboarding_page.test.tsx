import { afterEach, expect, test } from 'bun:test';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { type Library } from '../../../../../src/schemas/libraries';
import { PathSegment, route } from '../../../../../src/schemas/route';
import { DEFAULT_SETTINGS, type UpdateSettingsRequest } from '../../../../../src/schemas/settings';
import { librariesApi } from '../../../api/libraries';
import { settingsApi } from '../../../api/settings';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { OnboardingPage } = await import('../onboarding_page');
const { StoresProvider } = await import('../../../app/stores_context');

restoreApiAfterTests();
afterEach(cleanup);

const LIBRARY = { id: 'lib', name: 'Reef', root_path: '/nowhere/reef' } as unknown as Library;
const HOME = 'home';

async function open(libraries: Library[], saves = true): Promise<UpdateSettingsRequest[]> {
  const writes: UpdateSettingsRequest[] = [];
  librariesApi.list = () => Promise.resolve(libraries);
  librariesApi.getDefaults = () => Promise.resolve({} as Awaited<ReturnType<typeof librariesApi.getDefaults>>);
  settingsApi.update = (patch) => {
    writes.push(patch);
    return saves ? Promise.resolve({ ...DEFAULT_SETTINGS, ...patch }) : Promise.reject(new Error('offline'));
  };
  render(
    <MemoryRouter initialEntries={[route(PathSegment.welcome())]}>
      <StoresProvider>
        <Routes>
          <Route path={route(PathSegment.welcome())} element={<OnboardingPage />} />
          <Route path={route()} element={HOME} />
        </Routes>
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
  return writes;
}

async function press(name: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

test('with no library, finishing records onboarding as done', async () => {
  const writes = await open([]);
  expect(screen.getByText('Step 1 of 2')).toBeTruthy();
  await press('Skip');
  expect(screen.getByRole('heading', { name: 'Preferences' })).toBeTruthy();
  await press('Finish setup');
  expect(writes).toEqual([{ onboarding_complete: true }]);
  expect(screen.getByText(HOME)).toBeTruthy();
});

test('a finish that fails to save stays on the wizard', async () => {
  await open([], false);
  await press('Skip');
  await press('Finish setup');
  expect(screen.getByRole('button', { name: 'Finish setup' })).toBeTruthy();
  expect(screen.queryByText(HOME)).toBeNull();
});

test('with a library, the step after it is the preferences', async () => {
  await open([LIBRARY]);
  expect(screen.getByText('Step 1 of 2')).toBeTruthy();
  expect(screen.getByRole('list', { name: 'Libraries' }).textContent).toContain('/nowhere/reef');
  await press('Next');
  expect(screen.getByRole('heading', { name: 'Preferences' })).toBeTruthy();
});
