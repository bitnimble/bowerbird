import { afterEach, expect, test } from 'bun:test';
import { useEffect } from 'react';
import { registerDom } from '../../../test_dom';

registerDom();
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { StoresProvider, usePresenters } = await import('../../../app/stores_context');
const { Toasts } = await import('../toasts');

afterEach(cleanup);

let cancels = 0;
const cancel = (): void => {
  cancels += 1;
};

function Showing({ stoppable }: { stoppable: boolean }): JSX.Element {
  const { toasts } = usePresenters();
  useEffect(() => {
    const id = toasts.showProgress('Merging…', 0.5, stoppable ? cancel : undefined);
    return () => toasts.dismiss(id);
  }, [toasts, stoppable]);
  return <Toasts />;
}

test('work that can be stopped offers Cancel and no way to close the toast over it', () => {
  cancels = 0;
  render(
    <StoresProvider>
      <Showing stoppable />
    </StoresProvider>,
  );

  expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancels).toBe(1);
});

test('work that cannot be stopped can be dismissed', () => {
  render(
    <StoresProvider>
      <Showing stoppable={false} />
    </StoresProvider>,
  );

  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
});
