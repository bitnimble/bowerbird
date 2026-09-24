import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../../test_dom';
import type { SoftProof } from '../soft_proof';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { SoftProofMenu } = await import('../soft_proof_menu');

afterEach(cleanup);

async function opened(value: SoftProof, hdrOffered = true): Promise<SoftProof[]> {
  const chosen: SoftProof[] = [];
  render(<SoftProofMenu value={value} hdrOffered={hdrOffered} onChange={(proof) => chosen.push(proof)} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button'));
  });
  return chosen;
}

test('names the proof in force once there is one, and offers the library default by name', async () => {
  await opened('hdr');
  expect(screen.getByRole('button', { name: 'Soft proof' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Rec.2020 PQ HDR (default)' }).getAttribute('aria-current')).toBe('true');
  expect(screen.getByRole('menuitem', { name: 'sRGB' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Printed media' })).toBeTruthy();
  expect(screen.getByRole('menuitem', { name: 'Printed media (3D)' })).toBeTruthy();
  cleanup();

  await opened('print3d');
  expect(screen.getByRole('button', { name: 'Soft proof: Printed media (3D)' }).textContent).toBe('Printed media (3D)');
});

test('hands the choice to its owner', async () => {
  const chosen = await opened('hdr');
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Printed media' }));
  });
  expect(chosen).toEqual(['print']);
});

test('withholds an HDR proof from an SDR frame', async () => {
  await opened('srgb', false);
  expect(screen.getByRole('menuitem', { name: 'Rec.2020 PQ HDR (default)' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByRole('menuitem', { name: 'Printed media' }).getAttribute('aria-disabled')).not.toBe('true');
  expect(screen.getByRole('menuitem', { name: 'sRGB' }).getAttribute('aria-disabled')).not.toBe('true');
});
