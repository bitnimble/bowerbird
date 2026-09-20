// A release note is markdown written by whoever pushed the tag, and this is the only thing
// that reads it. The block shapes are worth pinning because GitHub's generated notes use all
// of them; the `javascript:` case is worth pinning because nothing else would catch it.
import { afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../../test_dom';

registerDom();
const { cleanup, render, screen } = await import('@testing-library/react');
const { ReleaseNotes } = await import('../release_notes');

afterEach(cleanup);

test('a heading, bullets and a paragraph come out as themselves', () => {
  render(<ReleaseNotes markdown={"## What's Changed\n* a thing\n* another thing\n\nplain words"} />);
  expect(screen.getByText("What's Changed")).toBeTruthy();
  expect(document.querySelectorAll('li')).toHaveLength(2);
  expect(screen.getByText('plain words').tagName).toBe('P');
});

// Release notes are written in an editor that wraps and read at whatever width the dialog
// is. Taken a line at a time, the second half of a bullet broke out of the list and landed
// full width underneath it, reading as a sentence that had lost its bullet.
test('a bullet wrapped onto the next line stays one bullet', () => {
  render(<ReleaseNotes markdown={'* the first half of a point\n  and the second half of it\n* a second point'} />);
  const items = document.querySelectorAll('li');
  expect(items).toHaveLength(2);
  expect(items[0]!.textContent).toBe('the first half of a point and the second half of it');
});

test('consecutive lines of prose are one paragraph', () => {
  render(<ReleaseNotes markdown={'one line\nand the next\n\napart'} />);
  const paragraphs = document.querySelectorAll('p');
  expect(paragraphs).toHaveLength(2);
  expect(paragraphs[0]!.textContent).toBe('one line and the next');
});

test('a link keeps its label and its target', () => {
  render(<ReleaseNotes markdown="see [the notes](https://example.invalid/x) for more" />);
  const link = screen.getByText('the notes') as HTMLAnchorElement;
  expect(link.tagName).toBe('A');
  expect(link.getAttribute('href')).toBe('https://example.invalid/x');
});

test('a bare URL is linked too, which is how a generated changelog ends', () => {
  render(<ReleaseNotes markdown="**Full Changelog**: https://example.invalid/compare" />);
  expect(screen.getByText('Full Changelog').tagName).toBe('STRONG');
  expect((screen.getByText('https://example.invalid/compare') as HTMLAnchorElement).getAttribute('href')).toBe(
    'https://example.invalid/compare',
  );
});

// The one thing here that is not cosmetic: a link is an `href`, and an `href` that is not
// http is script running inside the app, against a library it can reach the API of.
test('a link that is not http renders as text and not as a link', () => {
  render(<ReleaseNotes markdown="[click me](javascript:alert(1))" />);
  expect(document.querySelectorAll('a')).toHaveLength(0);
  expect(document.body.textContent).toContain('click me');
});

// The classic markdown-XSS case, and the reason nothing here ever builds markup: every
// fragment ends up a text node, so a tag in a release body is a tag the reader can see
// rather than an element the page ran.
test('markup in a release body is text, not markup', () => {
  render(<ReleaseNotes markdown={'<img src=x onerror="alert(1)"> and <script>alert(2)</script>'} />);
  expect(document.querySelectorAll('img, script')).toHaveLength(0);
  expect(document.body.textContent).toContain('<img src=x onerror="alert(1)">');
});

test('a code span is marked as code rather than left with its backticks', () => {
  render(<ReleaseNotes markdown="run `bun run test` first" />);
  expect(screen.getByText('bun run test').tagName).toBe('CODE');
});
