import { describe, expect, it, spyOn } from 'bun:test';
import { format, Logger } from '../logger';

describe('format', () => {
  it('renders the level, scope, message and fields on one line', () => {
    const line = format('info', 'sync', 'sync done', { library: 'abc', added: 3 });
    expect(line).toEndWith('INFO  [sync] sync done library=abc added=3');
  });

  it('quotes values that would otherwise run into the next field', () => {
    expect(format('info', 'sync', 'start', { root: '/photos/My Trip' })).toEndWith('root="/photos/My Trip"');
  });

  it('renders an error as its message', () => {
    expect(format('error', 'sync', 'failed', { err: new Error('disk gone') })).toEndWith('err="disk gone"');
  });

  it('leaves out fields with no value', () => {
    expect(format('info', 'sync', 'start', { paths: undefined, mode: 'full' })).toEndWith('start mode=full');
  });
});

describe('Logger', () => {
  it('drops anything below its level', () => {
    const out = spyOn(console, 'log').mockImplementation(() => {});
    try {
      new Logger('sync', 'warn').info('quiet');
      expect(out).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
    }
  });

  it('sends warn and error to stderr, with the stack of an error it was given', () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      new Logger('sync', 'debug').error('failed', { err: new Error('disk gone') });
      expect(err.mock.calls[0]?.[0]).toContain('Error: disk gone\n    at ');
    } finally {
      err.mockRestore();
    }
  });
});
