import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../test_dom';

registerDom();
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react');
const { EditableHeading } = await import('../editable_heading');

afterEach(cleanup);

const noSlashes = (name: string): string | null => (name.includes('/') ? 'no slashes' : null);

function open(props: { editable?: boolean; onRename?: (name: string) => void } = {}): HTMLInputElement {
  render(
    <EditableHeading
      value="Beach"
      label="Rename Beach"
      editable={props.editable ?? true}
      validate={noSlashes}
      onRename={props.onRename ?? (() => {})}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Beach' }));
  return screen.getByRole('textbox') as HTMLInputElement;
}

test('a read-only library leaves the title as a title, saying why on hover', () => {
  render(
    <EditableHeading value="Beach" label="Rename Beach" editable={false} refusal="Not here" onRename={() => {}} />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByText('Beach').getAttribute('aria-description')).toBe('Not here');
});

// A heading takes its name from its content, so labelling the button inside it
// with the action renames the heading itself for anyone listing them.
test('the heading is named by the title rather than by what clicking it does', () => {
  render(<EditableHeading value="Beach" label="Rename Beach" editable onRename={() => {}} />);
  expect(screen.getByRole('heading', { name: 'Beach' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Beach' }).getAttribute('aria-description')).toBe('Rename Beach');
});

test('Enter renames', () => {
  const renamed: string[] = [];
  const input = open({ onRename: (name) => renamed.push(name) });
  fireEvent.change(input, { target: { value: '  Cliffs  ' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(renamed).toEqual(['Cliffs']);
});

test('a name that is not a folder segment is refused rather than sent', () => {
  const renamed: string[] = [];
  const input = open({ onRename: (name) => renamed.push(name) });
  fireEvent.change(input, { target: { value: 'a/b' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(screen.getByText('no slashes')).toBeTruthy();
  expect(renamed).toEqual([]);
  // Still open, so the reader can fix what they typed.
  expect(screen.getByRole('textbox')).toBeTruthy();
});

test('blur drops an invalid draft instead of saving it', () => {
  const renamed: string[] = [];
  const input = open({ onRename: (name) => renamed.push(name) });
  fireEvent.change(input, { target: { value: 'a/b' } });
  fireEvent.blur(input);
  expect(renamed).toEqual([]);
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('Escape leaves the name alone', () => {
  const renamed: string[] = [];
  const input = open({ onRename: (name) => renamed.push(name) });
  fireEvent.change(input, { target: { value: 'Cliffs' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(renamed).toEqual([]);
  expect(screen.getByText('Beach')).toBeTruthy();
});
