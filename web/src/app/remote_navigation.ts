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

const FOCUSABLE = 'a[href], button, input, select, textarea, summary, [tabindex]';
const OWNS_HORIZONTAL =
  'input:not([type="checkbox"]), textarea, [role="slider"], [role="tablist"], [role="radiogroup"]';
const OWNS_ALL = 'select, [role="menu"], [role="listbox"]';
const LAYER = `${POPUP}, [role="alertdialog"]`;
const DIALOG = '[role="dialog"], [role="alertdialog"]';
const SIDEBAR = `nav[aria-label="${SidebarStrings.sidebar()}"]`;

const TOGGLES = new Set(['checkbox', 'radio']);

const OVERLAP = 2;
const ACROSS_WEIGHT = 2;

export function followRemote(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const active = document.activeElement;
    // A remote's centre button is Enter, and a native box toggles on Space alone.
    if (e.key === 'Enter' && active instanceof HTMLInputElement && TOGGLES.has(active.type)) {
      // Held, the button repeats, which would flip the box back.
      if (!e.repeat) active.click();
      e.preventDefault();
      return;
    }
    const direction = DIRECTIONS[e.key];
    if (direction == null) return;
    // Not a menu or a list: those move through their own items from the popup.
    const dialog = active instanceof HTMLElement && active.matches(DIALOG) ? active : null;
    if (!(active instanceof HTMLElement) || active === document.body || dialog != null) {
      // Nothing focused, or a dialog itself, as when its step replaces the control that held
      // the focus: start in the top layer, since what is behind a modal is not reachable.
      const layer = dialog ?? openLayers().at(-1);
      if (layer == null && document.querySelector(`[${OWNS_ARROWS}]`) != null) return;
      const first = focusables(layer ?? document.querySelector('main') ?? document.body)[0];
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

/** Open dialogs and popups in document order, which for portals is the order they opened in. */
function openLayers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(LAYER)].filter((each) =>
    each.checkVisibility({ checkVisibilityCSS: true }),
  );
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
