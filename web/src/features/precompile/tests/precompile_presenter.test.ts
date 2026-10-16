import { expect, test } from 'bun:test';
import { when } from 'mobx';
import { PrecompilePresenter, type Remembered } from '../precompile_presenter';
import { PrecompileStore } from '../precompile_store';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve = (): void => {};
  let reject = (): void => {};
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = () => fail(new Error('the GPU was reset'));
  });
  return { promise, resolve, reject };
}

/** The toasts the presenter asked for, as each one stands. */
function toasting(): {
  shown: Map<number, { message: string; progress: number }>;
  showProgress: (message: string, progress: number) => number;
  progressed: (id: number, message: string, progress: number) => void;
  dismiss: (id: number) => void;
} {
  const shown = new Map<number, { message: string; progress: number }>();
  let next = 1;
  return {
    shown,
    showProgress: (message, progress) => {
      shown.set(next, { message, progress });
      return next++;
    },
    progressed: (id, message, progress) => shown.set(id, { message, progress }),
    dismiss: (id) => shown.delete(id),
  };
}

function remembering(version: string | null): Remembered & { version: string | null } {
  const held = {
    version,
    read: () => held.version,
    write: (written: string) => {
      held.version = written;
    },
  };
  return held;
}

test('a device that precompiled this version starts ready, without compiling', () => {
  const store = new PrecompileStore();
  let asked = 0;
  const presenter = new PrecompilePresenter(
    store,
    () => {
      asked++;
      return deferred().promise;
    },
    '1.4.0',
    remembering('1.4.0'),
    toasting(),
  );
  presenter.start();

  expect(store.ready).toBe(true);
  expect(asked).toBe(0);
});

test('a new version compiles once however often it is asked for, then remembers it', async () => {
  const store = new PrecompileStore();
  const compile = deferred();
  const remembered = remembering('1.3.0');
  let asked = 0;
  const presenter = new PrecompilePresenter(
    store,
    () => {
      asked++;
      return compile.promise;
    },
    '1.4.0',
    remembered,
    toasting(),
  );

  presenter.start();
  presenter.start();
  expect(asked).toBe(1);
  expect(store.ready).toBe(false);

  compile.resolve();
  await when(() => store.ready, { timeout: 5000 });
  expect(remembered.version).toBe('1.4.0');
});

test('the store follows how many pipelines have compiled', () => {
  const store = new PrecompileStore();
  let report = (_compiled: number, _of: number): void => {};
  new PrecompilePresenter(
    store,
    (onCompiled) => {
      report = onCompiled;
      return deferred().promise;
    },
    '1.4.0',
    remembering(null),
    toasting(),
  ).start();

  report(0, 205);
  expect([store.compiled, store.toCompile]).toEqual([0, 205]);
  report(40, 205);
  expect([store.compiled, store.toCompile]).toEqual([40, 205]);
});

test('a compile that never finishes lets the app open once the wait runs out, and is not remembered', async () => {
  const store = new PrecompileStore();
  const remembered = remembering(null);
  new PrecompilePresenter(
    store,
    () => new Promise(() => {}),
    '1.4.0',
    remembered,
    toasting(),
    10,
  ).start();

  expect(store.ready).toBe(false);
  await when(() => store.ready, { timeout: 5000 });
  expect(remembered.version).toBe(null);
});

test('a compile that finishes after the wait ran out is still remembered', async () => {
  const store = new PrecompileStore();
  const compile = deferred();
  const remembered = remembering(null);
  new PrecompilePresenter(
    store,
    () => compile.promise,
    '1.4.0',
    remembered,
    toasting(),
    10,
  ).start();

  await when(() => store.ready, { timeout: 5000 });
  compile.resolve();
  await compile.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(remembered.version).toBe('1.4.0');
});

test('a compile still running when the app opens goes on in a toast, which closes when it is done', async () => {
  const store = new PrecompileStore();
  const compile = deferred();
  const toasts = toasting();
  let report = (_compiled: number, _of: number): void => {};
  new PrecompilePresenter(
    store,
    (onCompiled) => {
      report = onCompiled;
      return compile.promise;
    },
    '1.4.0',
    remembering(null),
    toasts,
    10,
  ).start();
  report(10, 200);

  await when(() => store.ready, { timeout: 5000 });
  expect([...toasts.shown.values()]).toEqual([
    { message: 'Precompiling shaders...', progress: 0.05 },
  ]);
  report(100, 200);
  expect([...toasts.shown.values()]).toEqual([
    { message: 'Precompiling shaders...', progress: 0.5 },
  ]);

  compile.resolve();
  await compile.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(toasts.shown.size).toBe(0);
});

test('a compile done before the wait ran out shows no toast', async () => {
  const store = new PrecompileStore();
  const compile = deferred();
  const toasts = toasting();
  new PrecompilePresenter(store, () => compile.promise, '1.4.0', remembering(null), toasts).start();

  compile.resolve();
  await when(() => store.ready, { timeout: 5000 });
  expect(toasts.shown.size).toBe(0);
});

test('a compile that fails opens the app, and is tried again on the next visit', async () => {
  const store = new PrecompileStore();
  const compile = deferred();
  const remembered = remembering(null);
  new PrecompilePresenter(store, () => compile.promise, '1.4.0', remembered, toasting()).start();

  compile.reject();
  await when(() => store.ready, { timeout: 5000 });
  expect(remembered.version).toBe(null);
});
