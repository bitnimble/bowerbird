import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { Tooltip, TooltipProvider } = await import('../tooltip');
const { Button } = await import('../button');

afterEach(cleanup);

async function hover(element: Element): Promise<void> {
  await act(async () => {
    fireEvent.mouseEnter(element);
    fireEvent.mouseMove(element);
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function renderTooltip(label: string | undefined, trigger: JSX.Element): void {
  render(
    <TooltipProvider delay={0}>
      <Tooltip label={label}>{trigger}</Tooltip>
    </TooltipProvider>,
  );
}

test('hovering shows the label', async () => {
  renderTooltip('Rename Beach', <button type="button">Beach</button>);
  expect(screen.queryByRole('tooltip')).toBeNull();
  await hover(screen.getByRole('button', { name: 'Beach' }));
  expect(screen.getByRole('tooltip').textContent).toBe('Rename Beach');
});

test('focusing shows the label', async () => {
  renderTooltip('Rename Beach', <button type="button">Beach</button>);
  await act(async () => {
    screen.getByRole('button', { name: 'Beach' }).focus();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(screen.getByRole('tooltip').textContent).toBe('Rename Beach');
});

test('no label shows nothing', async () => {
  renderTooltip(undefined, <button type="button">Beach</button>);
  await hover(screen.getByRole('button', { name: 'Beach' }));
  expect(screen.queryByRole('tooltip')).toBeNull();
});

test('a label that is not the name describes the trigger', () => {
  renderTooltip('Rename Beach', <button type="button">Beach</button>);
  expect(screen.getByRole('button', { name: 'Beach' }).getAttribute('aria-description')).toBe('Rename Beach');
});

test('a button that is only an icon shows its name', async () => {
  render(
    <TooltipProvider delay={0}>
      <Button iconOnly aria-label="Undo" />
    </TooltipProvider>,
  );
  await hover(screen.getByRole('button', { name: 'Undo' }));
  expect(screen.getByRole('tooltip').textContent).toBe('Undo');
});

test('a disabled button still says why', async () => {
  render(
    <TooltipProvider delay={0}>
      <Button disabled tooltip="Read-only library">
        Fetch
      </Button>
    </TooltipProvider>,
  );
  await hover(screen.getByRole('button', { name: 'Fetch' }));
  expect(screen.getByRole('tooltip').textContent).toBe('Read-only library');
});

test('a label that is the name is not read twice', () => {
  renderTooltip('Undo', <button type="button" aria-label="Undo" />);
  expect(screen.getByRole('button', { name: 'Undo' }).getAttribute('aria-description')).toBeNull();
});
