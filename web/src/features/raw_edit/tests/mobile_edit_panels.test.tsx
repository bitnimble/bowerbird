import { afterEach, describe, expect, test } from 'bun:test';
import { registerDom } from '../../../test_dom';
import { MobileEditPanelsPresenter } from '../mobile_edit_panels_presenter';
import { MobileEditPanelsStore } from '../mobile_edit_panels_store';

registerDom();
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { MobileEditPanels } = await import('../mobile_edit_panels');

afterEach(cleanup);

const panels = [
  { id: 'light', title: 'Light', content: <input aria-label="Exposure" /> },
  { id: 'color', title: 'Colour', content: <input aria-label="Saturation" /> },
];

describe('mobile edit panels', () => {
  test('starts collapsed and keeps selected controls mounted while collapsed', () => {
    render(<MobileEditPanels scope="photo" panels={panels} />);
    const light = screen.getByRole('tab', { name: 'Light' });
    expect(light.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('tabpanel')).toBeNull();
    fireEvent.click(light);
    const input = screen.getByRole('textbox', { name: 'Exposure' });
    expect(screen.getByRole('tabpanel', { name: 'Light' }).contains(input)).toBe(true);
    fireEvent.click(light);
    expect(screen.queryByRole('textbox', { name: 'Exposure' })).toBeNull();
    expect(input.isConnected).toBe(true);
    expect(screen.getByRole('tabpanel', { hidden: true }).hasAttribute('inert')).toBe(true);
    fireEvent.click(light);
    expect(screen.getByRole('textbox', { name: 'Exposure' })).toBe(input);
  });

  test('switches tabs with arrows and closes to the selected tab on Escape', () => {
    render(<MobileEditPanels scope="photo" panels={panels} />);
    const light = screen.getByRole('tab', { name: 'Light' });
    const color = screen.getByRole('tab', { name: 'Colour' });
    fireEvent.keyDown(light, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(color);
    expect(color.getAttribute('aria-selected')).toBe('true');
    expect(color.tabIndex).toBe(0);
    expect(light.tabIndex).toBe(-1);
    fireEvent.keyDown(color, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(light);
    fireEvent.keyDown(light, { key: 'End' });
    expect(document.activeElement).toBe(color);
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Saturation' }), { key: 'Escape' });
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(document.activeElement).toBe(color);
  });

  test('an outside tap closes the panel after the pointer is released and leaves tabs usable', () => {
    render(<MobileEditPanels scope="photo" panels={panels} />);
    const light = screen.getByRole('tab', { name: 'Light' });
    fireEvent.click(light);
    const dismiss = screen.getByRole('button', { name: 'Close edit panel' });
    fireEvent.pointerDown(dismiss);
    expect(light.getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerUp(dismiss);
    fireEvent.click(dismiss);
    expect(light.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: 'Close edit panel' })).toBeNull();
    expect(screen.queryByRole('tabpanel')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Colour' }));
    expect(screen.getByRole('tabpanel', { name: 'Colour' }).contains(screen.getByRole('textbox', { name: 'Saturation' }))).toBe(true);
  });

  test('a new photo or tool resets the footer to collapsed', () => {
    const view = render(<MobileEditPanels scope="photo" panels={panels} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Light' }));
    view.rerender(<MobileEditPanels scope="another-photo" panels={panels} />);
    expect(screen.queryByRole('tabpanel')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Light' }).getAttribute('aria-expanded')).toBe('false');
  });

  test('save failures remain visible and actionable when panels are collapsed', () => {
    render(<MobileEditPanels scope="photo" panels={panels} notice={<button>Retry saving</button>} />);
    expect(screen.getByRole('status').contains(screen.getByRole('button', { name: 'Retry saving' }))).toBe(true);
    const light = screen.getByRole('tab', { name: 'Light' });
    fireEvent.click(light);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Retry saving' })).toHaveLength(1);
    fireEvent.click(light);
    expect(screen.getByRole('status').contains(screen.getByRole('button', { name: 'Retry saving' }))).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Retry saving' })).toHaveLength(1);
  });

  test('only the active drag can restore the panel and tab switches cannot interrupt it', () => {
    const store = new MobileEditPanelsStore();
    const presenter = new MobileEditPanelsPresenter(store);
    const rectangle = { left: 10, top: 400, width: 300, height: 60 };
    presenter.begin('exposure', rectangle);
    expect(store.activeSlider).toBeNull();
    presenter.toggle('light');
    presenter.begin('exposure', rectangle);
    presenter.begin('saturation', rectangle);
    presenter.toggle('color');
    presenter.close();
    expect(presenter.navigate('light', ['light', 'color'], 'ArrowRight')).toBeNull();
    presenter.end('saturation');
    expect(store.activeSlider?.id).toBe('exposure');
    expect(store.selectedId).toBe('light');
    expect(store.expanded).toBe(true);
    presenter.end('exposure');
    expect(store.activeSlider).toBeNull();
    presenter.begin('exposure', rectangle);
    presenter.dispose();
    expect(store.activeSlider).toBeNull();
    expect(store.expanded).toBe(false);
  });
});
