import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../test_dom';
import { pointerEvent } from '../../../ui/tests/pointer_event';
import { openEditor, runFrames } from '../stage/tests/raw_edit_harness';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MemoryRouter } = await import('react-router-dom');
const { RawEditPanel } = await import('../raw_edit_panel');

afterEach(cleanup);

test('a touch drag moves the thumb on every move while the picture is still drawing', () => {
  const editor = openEditor();
  editor.decoder.landed = () => new Promise(() => {});
  render(
    <MemoryRouter>
      <RawEditPanel
        edit={editor.edit}
        stage={editor.stage}
        crop={editor.crop}
        keystone={editor.keystone}
        repair={editor.repair}
        colourWheel={editor.colourWheel}
        print={editor.print}
        presenter={editor.presenter}
        mobile
      />
    </MemoryRouter>,
  );
  act(() => fireEvent.click(screen.getByRole('tab', { name: 'Light' })));
  const slider = screen.getByRole('slider', { name: 'Exposure' });

  fireEvent(slider, pointerEvent('pointerdown', { touch: true, x: 100, y: 10 }));
  // The track is 200px over -5 to 5 EV.
  for (const [x, ev] of [
    [130, 1.5],
    [140, 2],
    [150, 2.5],
    [160, 3],
  ] as const) {
    fireEvent(slider, pointerEvent('pointermove', { touch: true, x, y: 12 }));
    expect(slider.getAttribute('aria-valuenow')).toBe(String(ev));
    runFrames();
  }
  expect(editor.decoder.draws).toBe(1);
});
