import { SidebarStrings } from '../features/sidebar/sidebar.strings';
import { POPUP } from '../ui/menu_styles';
import { TV_BACK } from './tv';

export type Direction = 'up' | 'down' | 'left' | 'right';

export type Box = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>;

const DIRECTIONS: Partial<Record<string, Direction>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const OWNS_ARROWS = 'data-owns-arrows';

/**
 * Marks a region whose own key handler moves through it, so the remote's arrows reach that
 * handler: all four, or only left and right, with up and down leaving it.
 */
export function ownsArrows(arrows: 'all' | 'sideways'): Record<string, string> {
  return { [OWNS_ARROWS]: arrows };
}

const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';
const OWNS_HORIZONTAL =
  'input:not([type="checkbox"]), textarea, [role="slider"], [role="tablist"], [role="radiogroup"]';
const OWNS_ALL = 'select, [role="menu"], [role="listbox"]';
const LAYER = `${POPUP}, [role="alertdialog"]`;
const SIDEBAR = `nav[aria-label="${SidebarStrings.sidebar()}"]`;

const OVERLAP = 2;
const ACROSS_WEIGHT = 2;

export function followRemote(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const direction = DIRECTIONS[e.key];
    if (direction == null || e.defaultPrevented) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) {
      if (document.querySelector(`[${OWNS_ARROWS}]`) != null) return;
      const first = focusables(document.querySelector('main') ?? document.body)[0];
      if (first == null) return;
      first.focus();
    } else {
      const horizontal = direction === 'left' || direction === 'right';
      const owner = active.closest<HTMLElement>(`[${OWNS_ARROWS}]`);
      if (owner != null && (horizontal || owner.getAttribute(OWNS_ARROWS) === 'all')) return;
      if (active.closest(OWNS_ALL) != null) return;
      if (horizontal && active.closest(OWNS_HORIZONTAL) != null) return;
      focusToward(owner ?? active, direction);
    }
    // Spent even where nothing lies that way: the grid's window handler would otherwise move a
    // cursor the focus is nowhere near.
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, { capture: true });
  window[TV_BACK] = goBack;
  return () => {
    window.removeEventListener('keydown', onKey, { capture: true });
    delete window[TV_BACK];
  };
}

/**
 * Focuses the nearest control in `direction`, or a navigation's current link on entering it;
 * false where nothing lies that way.
 */
export function focusToward(from: HTMLElement, direction: Direction): boolean {
  const candidates = focusables(from.closest(LAYER) ?? document.body).filter(
    (each) => !each.contains(from) && !from.contains(each),
  );
  const best = nearest(
    from.getBoundingClientRect(),
    candidates.map((each) => each.getBoundingClientRect()),
    direction,
  );
  if (best == null) return false;
  const reached = candidates[best]!;
  const nav = reached.closest('nav');
  const current =
    nav == null || nav.contains(from)
      ? null
      : nav.querySelector<HTMLElement>('[aria-current="page"]');
  (current != null && candidates.includes(current) ? current : reached).focus();
  return true;
}

/** Index of the box nearest `from` in `direction`, or null where none lies that way. */
export function nearest(from: Box, boxes: readonly Box[], direction: Direction): number | null {
  let best: number | null = null;
  let bestDistance = Infinity;
  boxes.forEach((box, i) => {
    const distance = distanceToward(from, box, direction);
    if (distance != null && distance < bestDistance) {
      best = i;
      bestDistance = distance;
    }
  });
  return best;
}

/**
 * The remote's Back: whatever is open closes first, then the sidebar takes the focus. False once
 * the focus is already there, which leaves the app.
 */
function goBack(): boolean {
  const active =
    document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const inLayer = inOpenLayer(active);
  const escape = new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  // Popups close on Escape without preventing its default.
  if (!active.dispatchEvent(escape) || inLayer) return true;
  const sidebar = document.querySelector<HTMLElement>(SIDEBAR);
  if (sidebar == null || sidebar.contains(active)) return false;
  const current =
    sidebar.querySelector<HTMLElement>('[aria-current="page"]') ?? focusables(sidebar)[0];
  if (current == null) return false;
  current.focus();
  return true;
}

/** Inside an open popup, or on the control that opened it: the popup's focus can arrive a frame late. */
export function inOpenLayer(element: Element): boolean {
  return element.closest(`${LAYER}, [aria-haspopup][aria-expanded="true"]`) != null;
}

function focusables(root: Element): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (each) =>
      each.tabIndex >= 0 &&
      !each.matches(':disabled') &&
      each.closest('[inert]') == null &&
      each.parentElement?.closest(`[${OWNS_ARROWS}]`) == null &&
      each.checkVisibility({ checkVisibilityCSS: true }),
  );
}

function distanceToward(from: Box, to: Box, direction: Direction): number | null {
  const vertical = direction === 'up' || direction === 'down';
  const gap = {
    right: to.left - from.right,
    left: from.left - to.right,
    down: to.top - from.bottom,
    up: from.top - to.bottom,
  }[direction];
  if (gap < -OVERLAP) return null;
  const across = vertical
    ? apart(from.left, from.right, to.left, to.right)
    : apart(from.top, from.bottom, to.top, to.bottom);
  return Math.max(gap, 0) + across * ACROSS_WEIGHT;
}

function apart(fromStart: number, fromEnd: number, toStart: number, toEnd: number): number {
  return Math.max(0, toStart - fromEnd, fromStart - toEnd);
}
