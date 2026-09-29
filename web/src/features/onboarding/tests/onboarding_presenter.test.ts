import { expect, test } from 'bun:test';
import { when } from 'mobx';
import { OnboardingPresenter } from '../onboarding_presenter';
import { OnboardingStore } from '../onboarding_store';

function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
  let resolve = (): void => {};
  let reject = (): void => {};
  const promise = new Promise<void>((settle, fail) => {
    resolve = settle;
    reject = () => fail(new Error('the GPU was reset'));
  });
  return { promise, resolve, reject };
}

test('with nothing to compile, the wizard is ready from the start', () => {
  const store = new OnboardingStore();
  new OnboardingPresenter(store, null);

  expect(store.pipelinesReady).toBe(true);
});

test('the wizard waits for the compile, which runs once however often it is asked for', async () => {
  const store = new OnboardingStore();
  const compile = deferred();
  let asked = 0;
  const presenter = new OnboardingPresenter(store, () => {
    asked++;
    return compile.promise;
  });

  presenter.preparePipelines();
  presenter.preparePipelines();
  expect(asked).toBe(1);
  expect(store.pipelinesReady).toBe(false);

  compile.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.pipelinesReady).toBe(true);
});

test('the store follows how many pipelines have compiled', () => {
  const store = new OnboardingStore();
  let report = (_compiled: number, _of: number): void => {};
  new OnboardingPresenter(store, (onCompiled) => {
    report = onCompiled;
    return deferred().promise;
  }).preparePipelines();

  report(0, 205);
  expect([store.pipelinesCompiled, store.pipelinesToCompile]).toEqual([0, 205]);
  report(40, 205);
  expect([store.pipelinesCompiled, store.pipelinesToCompile]).toEqual([40, 205]);
});

test('a compile that never finishes lets setup carry on once the wait runs out', async () => {
  const store = new OnboardingStore();
  new OnboardingPresenter(store, () => new Promise(() => {}), 10).preparePipelines();

  expect(store.pipelinesReady).toBe(false);
  await when(() => store.pipelinesReady, { timeout: 5000 });
});

test('a compile that fails still lets setup carry on', async () => {
  const store = new OnboardingStore();
  const compile = deferred();
  new OnboardingPresenter(store, () => compile.promise).preparePipelines();

  compile.reject();
  await compile.promise.catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.pipelinesReady).toBe(true);
});
