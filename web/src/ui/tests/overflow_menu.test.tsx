import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { OverflowMenu } = await import('../overflow_menu');
const { menuSection } = await import('../menu_section');

afterEach(cleanup);

function Menu({ label, action, hotkey = true }: { label: string; action: string; hotkey?: boolean }): JSX.Element {
  return (
    <OverflowMenu
      hotkey={hotkey}
      label={label}
      sections={[menuSection({ options: [{ value: 'go', label: action }], onSelect: () => {} })]}
    />
  );
}

async function press(key: string, on: Element | Window = window): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(on, { key });
  });
}

test('backslash opens and closes the newest menu that answers to it', async () => {
  render(
    <>
      <Menu label="Page" action="Page action" />
      <Menu label="Bar" action="Bar action" />
      <Menu label="Row" action="Row action" hotkey={false} />
    </>,
  );

  await press('\\');
  expect(screen.getByRole('menuitem', { name: 'Bar action' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Page action' })).toBeNull();

  await press('\\');
  expect(screen.queryByRole('menuitem', { name: 'Bar action' })).toBeNull();
});

test('backslash typed into a field is the field’s', async () => {
  render(
    <>
      <input aria-label="Name" />
      <Menu label="Page" action="Page action" />
    </>,
  );

  await press('\\', screen.getByRole('textbox', { name: 'Name' }));

  expect(screen.queryByRole('menuitem', { name: 'Page action' })).toBeNull();
});
