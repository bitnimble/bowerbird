import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';

registerDom();
const { cleanup, render, screen } = await import('@testing-library/react');
const { TriageControl } = await import('../triage_control');

afterEach(cleanup);

test('the phone verdict buttons omit keyboard shortcuts', () => {
  render(<TriageControl value="untriaged" onChange={() => {}} stretch />);

  for (const label of ['Undecided', 'Reject', 'Pick']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
  for (const key of ['Z', 'X', 'C']) expect(screen.queryByText(key)).toBeNull();
});

test('the regular verdict buttons keep keyboard shortcuts', () => {
  render(<TriageControl value="untriaged" onChange={() => {}} />);

  for (const key of ['Z', 'X', 'C']) expect(screen.getByText(key)).toBeTruthy();
});
