import { describe, it, expect } from 'bun:test';
import { libraryMutex } from '../library_mutex';

const defer = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('libraryMutex', () => {
  it('serializes work on the same library and runs different libraries in parallel', async () => {
    const order: string[] = [];
    const a = defer();

    const first = libraryMutex.run('lib', async () => {
      order.push('a:start');
      await a.promise;
      order.push('a:end');
    });
    const second = libraryMutex.run('lib', async () => {
      order.push('b');
    });
    const other = libraryMutex.run('other-lib', async () => {
      order.push('other');
    });

    await other; // a different library isn't blocked by the held 'lib'
    expect(order).toEqual(['a:start', 'other']);

    a.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'other', 'a:end', 'b']); // b waited for a
  });

  it('a rejection does not poison the queue behind it', async () => {
    const failed = libraryMutex.run('lib2', async () => {
      throw new Error('boom');
    });
    const after = libraryMutex.run('lib2', async () => 'ok');

    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });
});
