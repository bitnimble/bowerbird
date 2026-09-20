// A DOM for `bun test`, so a component can be asked what it does without a browser.
//
// **What this is for is the wiring, not the picture.** A GPU device, a shader, a canvas and
// anything that has to be *measured* stay in Playwright; what happens here is the layer between
// a control and a presenter, which is a question about two objects and was costing a full RAW
// decode to ask.
//
// **jsdom rather than happy-dom**, which was tried first: Base UI's slider sends happy-dom into
// a loop that ends in the machine running out of memory, and does not under this one.
//
// **Called by the test that wants it, not preloaded.** A preload would install a DOM for every
// suite in the repo, and the server's tests share this runner - one of them assigns
// `globalThis.sessionStorage`, which a DOM defines as read-only. The caller registers first and
// then `await import`s the testing library, which reaches for `document` as it is imported.
//
// **Every component the file renders is `await import`ed too, and a static one is a bug.** A
// file's static imports evaluate before its body, so a component named at the top loads before
// this runs - and Base UI decides once, at import, whether it has a DOM. The registry is shared
// by the whole run, so one such file leaves every popover in every *other* suite rendering with
// no popup attached, in a suite that passes when it is run alone.
import { JSDOM } from 'jsdom';

let registered = false;

export function registerDom(): void {
  if (registered) return;
  registered = true;
  install();
}

function install(): void {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });

  const window = dom.window as unknown as Window & typeof globalThis;

  // Named rather than copied wholesale: `Object.assign(globalThis, window)` also brings across
  // `location`, `history` and `performance`, which bun already has and which the test runner
  // itself is using.
  const carried = [
    'window',
    'document',
    'sessionStorage',
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLImageElement',
    'HTMLVideoElement',
    'Element',
    'Node',
    'Event',
    'CustomEvent',
    'KeyboardEvent',
    'MouseEvent',
    'PointerEvent',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'DOMRect',
    'MutationObserver',
    // Base UI's `DialogPortal` reads a bare `open` it never declared, so an open dialog throws without it.
    'open',
  ] as const;

  for (const name of carried) {
    const value = (window as unknown as Record<string, unknown>)[name];
    if (value !== undefined) {
      Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    }
  }

  // React 18 reads this to decide whether it may flush effects synchronously, which is what lets
  // a test assert on what a render produced rather than on what it is about to produce.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  // **There is no layout here**: every box measures zero and there is no `ResizeObserver` at
  // all. A component that turns a position into a value divides by its own width, and one that
  // waits for its first measurement before wiring anything up never gets one from a stub that
  // stays silent - so both answer, with a box that is merely plausible.
  const box = { x: 0, y: 0, width: 200, height: 20, top: 0, left: 0, right: 200, bottom: 20 };

  Object.defineProperty(globalThis.Element.prototype, 'getBoundingClientRect', {
    value: () => ({ ...box, toJSON: () => box }),
    configurable: true,
    writable: true,
  });

  // jsdom implements none of the pointer capture methods, and a listener that calls one
  // throws - which `dispatchEvent` then swallows, so the event appears to have been
  // handled and done nothing. A drag guarded by `hasPointerCapture` therefore *passes* a
  // test asserting it moved nothing, whichever way the guard is written. Captures are
  // tracked here instead, so the guard is answered rather than thrown past.
  // One element per pointer, which is what a capture is.
  const captured = new Map<number, Element>();

  const capture = {
    setPointerCapture(this: Element, id: number): void {
      captured.set(id, this);
    },
    hasPointerCapture(this: Element, id: number): boolean {
      return captured.get(id) === this;
    },
    releasePointerCapture(this: Element, id: number): void {
      if (captured.get(id) === this) captured.delete(id);
    },
  };

  for (const [name, value] of Object.entries(capture)) {
    Object.defineProperty(globalThis.Element.prototype, name, { value, configurable: true, writable: true });
  }

  // A browser drops the capture of its own accord once the pointer is lifted, and a
  // component is written expecting that - without it here, a drag carries on following
  // a pointer that was let go, and a test would pin behaviour no browser has.
  for (const lifted of ['pointerup', 'pointercancel']) {
    window.document.addEventListener(lifted, (e) => captured.delete((e as PointerEvent).pointerId));
  }

  // jsdom answers no media query at all, so a component that asks one as it mounts
  // throws rather than rendering. Desktop and a mouse: what a control does under a
  // finger is Playwright's.
  Object.defineProperty(window, 'matchMedia', {
    value: (media: string) => ({
      media,
      matches: false,
      addEventListener: (): void => {},
      removeEventListener: (): void => {},
    }),
    configurable: true,
    writable: true,
  });

  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: class {
      constructor(private readonly report: ResizeObserverCallback) {}

      observe(target: Element): void {
        this.report(
          [{ target, contentRect: box as DOMRectReadOnly } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }

      unobserve(): void {}

      disconnect(): void {}
    },
    configurable: true,
    writable: true,
  });
}
