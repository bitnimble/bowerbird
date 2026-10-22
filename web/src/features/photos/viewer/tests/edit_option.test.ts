import { expect, test } from 'bun:test';
import { editOption, fetchOriginalThenEdit } from '../edit_option';

const base = {
  editable: true,
  fetchingOriginal: false,
  readOnly: false,
  unreachable: false,
  editHref: 'p1-editor',
  replace: false,
};

test('links straight to the editor where the original is here', () => {
  const option = editOption(base);
  expect(option.label).toBe('Edit');
  expect(option.link?.props).toMatchObject({ to: 'p1-editor', replace: false });
});

test('fetches the original first where it is elsewhere, holding the menu open while it does', () => {
  const fetch = editOption({ ...base, editable: false });
  expect(fetch).toMatchObject({
    label: 'Fetch original and edit',
    disabled: false,
    keepsMenuOpen: true,
  });
  expect(fetch.link).toBeUndefined();
  expect(editOption({ ...base, editable: false, fetchingOriginal: true })).toMatchObject({
    label: 'Fetching original…',
    disabled: true,
  });
});

test('says why an original cannot be fetched', () => {
  expect(editOption({ ...base, editable: false, readOnly: true })).toMatchObject({
    disabled: true,
    tooltip: 'This library is read-only.',
  });
  expect(editOption({ ...base, editable: false, unreachable: true })).toMatchObject({
    disabled: true,
    tooltip: "No local copy. The device holding it can't be reached from here.",
  });
});

test('opens the editor only once the original has landed', async () => {
  const edited: string[] = [];
  const replication = (fetched: boolean) => ({ fetchOriginalAndWait: async () => fetched });

  await fetchOriginalThenEdit(replication(false), 'p1', () => edited.push('p1'));
  await fetchOriginalThenEdit(replication(true), 'p2', () => edited.push('p2'));

  expect(edited).toEqual(['p2']);
});
