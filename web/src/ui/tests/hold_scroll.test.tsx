import { afterEach, expect, test } from 'bun:test';
import { useRef } from 'react';
import { registerDom } from '../../test_dom';

registerDom();
const { cleanup, render, screen } = await import('@testing-library/react');
const { useHoldScroll } = await import('../hold_scroll');

afterEach(cleanup);

const held = { now: false };

function Held(): JSX.Element {
  const element = useRef<HTMLDivElement>(null);
  useHoldScroll(element, () => held.now);
  return (
    <div ref={element}>
      <span>Handle</span>
    </div>
  );
}

function moved(): boolean {
  const event = new Event('touchmove', { bubbles: true, cancelable: true });
  screen.getByText('Handle').dispatchEvent(event);
  return event.defaultPrevented;
}

test('a touch moving over a held drag does not scroll, and one over nothing held does', () => {
  render(<Held />);
  held.now = false;
  expect(moved()).toBe(false);
  held.now = true;
  expect(moved()).toBe(true);
});
