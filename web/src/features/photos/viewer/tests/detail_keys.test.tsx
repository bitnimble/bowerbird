// The viewer's own keys for its two side panels: `[` the filmstrip and `]` the photo info.
import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { StoresProvider } = await import('../../../../app/stores_context');
const { DetailKeys } = await import('../detail_keys');

afterEach(cleanup);

async function open(toggles: { strip?: () => void; panels?: () => void }): Promise<void> {
  render(
    <MemoryRouter>
      <StoresProvider>
        <input aria-label="Note" />
        <DetailKeys
          photoId="p1"
          mode="view"
          onExitPreview={() => {}}
          onToggleStrip={toggles.strip}
          onTogglePanels={toggles.panels}
        />
      </StoresProvider>
    </MemoryRouter>,
  );
  await act(async () => {});
}

async function press(key: string, on: Element = document.body): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(on, { key });
  });
}

test('[ toggles the filmstrip and ] the photo info', async () => {
  const pressed: string[] = [];
  await open({ strip: () => pressed.push('strip'), panels: () => pressed.push('panels') });

  await press('[');
  await press(']');

  expect(pressed).toEqual(['strip', 'panels']);
});

test('a bracket typed into a field is the field’s', async () => {
  const pressed: string[] = [];
  await open({ strip: () => pressed.push('strip'), panels: () => pressed.push('panels') });

  await press('[', screen.getByRole('textbox', { name: 'Note' }));

  expect(pressed).toEqual([]);
});
