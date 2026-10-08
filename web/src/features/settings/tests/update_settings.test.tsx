// A Play Store build checks for no updates, so Settings must not offer a check that does nothing.
import { afterEach, expect, test } from 'bun:test';
import { runInAction } from 'mobx';
import { useEffect } from 'react';
import { type UpdateStatus } from '../../../../../src/schemas/updates';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { UpdateSettings } = await import('../settings_page');
const { StoresProvider, useUpdatesStore } = await import('../../../app/stores_context');

afterEach(cleanup);

function Seed({ status }: { status: UpdateStatus }): null {
  const updates = useUpdatesStore();
  useEffect(() => {
    runInAction(() => (updates.status = status));
  }, [updates, status]);
  return null;
}

async function open(checks: boolean): Promise<void> {
  const status: UpdateStatus = {
    current: '0.1.15',
    checks,
    newer: [],
    can_install: false,
    install_hint: null,
    checked_at: null,
    error: null,
  };
  render(
    <StoresProvider>
      <Seed status={status} />
      <UpdateSettings />
    </StoresProvider>,
  );
  await act(async () => {});
}

test('where updates are checked, Settings offers a check', async () => {
  await open(true);
  expect(screen.getByText('0.1.15')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check now' })).toBeTruthy();
  expect(screen.getByText('Not checked yet')).toBeTruthy();
});

test('where checking is off, Settings shows the version alone', async () => {
  await open(false);
  expect(screen.getByText('0.1.15')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  expect(screen.queryByText('Not checked yet')).toBeNull();
});
