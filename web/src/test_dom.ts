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
    'navigator',
    'HTMLElement',
    'HTMLInputElement',
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
