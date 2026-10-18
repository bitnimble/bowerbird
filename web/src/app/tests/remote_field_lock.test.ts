import { afterAll, afterEach, expect, test } from 'bun:test';
import { registerDom } from '../../test_dom';

registerDom();
const { focusToward, followRemote } = await import('../remote_navigation');

const rects = new Map<Element, DOMRect>();
const realRect = HTMLElement.prototype.getBoundingClientRect;
const realVisibility = HTMLElement.prototype.checkVisibility;
HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
  return rects.get(this) ?? realRect.call(this);
};
HTMLElement.prototype.checkVisibility = () => true;

afterEach(() => {
  document.body.replaceChildren();
  rects.clear();
});

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
  HTMLElement.prototype.checkVisibility = realVisibility;
});

test('a field reached by remote waits for OK, and that OK only unlocks it', () => {
  const main = document.createElement('main');
  const button = document.createElement('button');
  const field = document.createElement('input');
  main.append(button, field);
  document.body.append(main);
  rects.set(button, { left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 } as DOMRect);
  rects.set(field, { left: 0, top: 40, right: 40, bottom: 60, width: 40, height: 20 } as DOMRect);
  let submitted = 0;
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitted++;
  });
  const stop = followRemote();

  expect(focusToward(button, 'down')).toBe(true);
  expect(document.activeElement).toBe(field);
  expect(field.readOnly).toBe(true);

  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(field.readOnly).toBe(false);
  expect(document.activeElement).toBe(field);
  expect(submitted).toBe(0);

  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(submitted).toBe(1);
  stop();
});
