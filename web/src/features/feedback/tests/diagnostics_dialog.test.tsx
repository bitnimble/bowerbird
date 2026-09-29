import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, render, screen } = await import('@testing-library/react');
const { DiagnosticsDialog } = await import('../diagnostics_dialog');

afterEach(cleanup);

test('lists what this page runs in, each answer beside its name', async () => {
  render(<DiagnosticsDialog open onOpenChange={() => {}} />);
  await act(async () => {});

  expect(screen.getByRole('dialog', { name: 'Diagnostics' })).toBeTruthy();
  const rows = Object.fromEntries(
    screen
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent]),
  );
  expect(rows).toMatchObject({
    'GPU adapter': 'no WebGPU',
    'HDR display': 'No',
    ImageDecoder: 'No',
    'Cross-origin isolated': 'No',
  });
  expect(rows.Browser).toContain('jsdom');
});
