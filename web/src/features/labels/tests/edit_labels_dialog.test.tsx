// What the edit labels dialog's controls do: a delete that would take a label off photos asks
// first, and nothing is written until Save.
import { afterEach, expect, test } from 'bun:test';
import { useEffect } from 'react';
import type { Label, SaveLabelsRequest } from '../../../../../src/schemas/labels';
import { labelsApi } from '../../../api/labels';
import { restoreApiAfterTests } from '../../../test_api';
import { registerDom } from '../../../test_dom';

registerDom();
const { act, cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { StoresProvider, usePresenters } = await import('../../../app/stores_context');
const { EditLabelsDialog } = await import('../edit_labels_dialog');

restoreApiAfterTests();
afterEach(cleanup);

const LIB = 'library1';
const HELD: Label[] = [
  { id: 'label001', library_id: LIB, name: 'Keeper', colour: '#e5484d', position: 0, photo_count: 3 },
  { id: 'label002', library_id: LIB, name: 'Print', colour: '#46a758', position: 1, photo_count: 0 },
];

function Open(): null {
  const { labels } = usePresenters();
  useEffect(() => void labels.openEditor(LIB), [labels]);
  return null;
}

async function openDialog(): Promise<SaveLabelsRequest[]> {
  const saved: SaveLabelsRequest[] = [];
  labelsApi.list = () => Promise.resolve(HELD);
  labelsApi.save = (body) => {
    saved.push(body);
    return Promise.resolve(HELD);
  };
  render(
    <StoresProvider>
      <Open />
      <EditLabelsDialog />
    </StoresProvider>,
  );
  await act(async () => {});
  return saved;
}

function names(): string[] {
  return screen.queryAllByRole('textbox', { name: 'Label name' }).map((field) => (field as HTMLInputElement).value);
}

test('asks before deleting a label that is on photos, quoting how many', async () => {
  await openDialog();
  const asked: string[] = [];
  let answer = false;
  window.confirm = (text?: string) => {
    asked.push(text ?? '');
    return answer;
  };

  fireEvent.click(screen.getByRole('button', { name: 'Delete Keeper' }));
  expect(asked).toEqual(["Delete Keeper? It's on 3 photos."]);
  expect(names()).toEqual(['Keeper', 'Print']);

  answer = true;
  fireEvent.click(screen.getByRole('button', { name: 'Delete Keeper' }));
  expect(names()).toEqual(['Print']);

  fireEvent.click(screen.getByRole('button', { name: 'Delete Print' }));
  expect(asked).toHaveLength(2);
  expect(names()).toEqual([]);
});

test('writes nothing until Save, then the whole list', async () => {
  const saved = await openDialog();
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save.hasAttribute('disabled') || save.getAttribute('aria-disabled') === 'true').toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Add label' }));
  const fields = screen.getAllByRole('textbox', { name: 'Label name' });
  fireEvent.change(fields[2]!, { target: { value: 'Sky' } });
  expect(saved).toEqual([]);

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  });
  expect(saved.map((body) => body.labels)).toEqual([
    [{ id: 'label001' }, { id: 'label002' }, { name: 'Sky', colour: '#ffc53d' }],
  ]);
  expect(screen.queryByRole('dialog')).toBeNull();
});
