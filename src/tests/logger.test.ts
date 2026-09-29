import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { format, Logger, LogOutput, logOutput } from '../logger';

describe('format', () => {
  it('renders the level, scope, message and fields on one line', () => {
    const line = format('info', 'sync', 'sync done', { library: 'abc', added: 3 });
    expect(line).toEndWith('INFO  [sync] sync done library=abc added=3');
  });

  it('quotes values that would otherwise run into the next field', () => {
    expect(format('info', 'sync', 'start', { root: '/photos/My Trip' })).toEndWith(
      'root="/photos/My Trip"',
    );
  });

  it('renders an error as its message', () => {
    expect(format('error', 'sync', 'failed', { err: new Error('disk gone') })).toEndWith(
      'err="disk gone"',
    );
  });

  it('leaves out fields with no value', () => {
    expect(format('info', 'sync', 'start', { paths: undefined, mode: 'full' })).toEndWith(
      'start mode=full',
    );
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

  it('keeps what it writes for the logs dialog', () => {
    const out = spyOn(console, 'log').mockImplementation(() => {});
    try {
      new Logger('sync', 'debug').info('kept for later');
      expect(logOutput.recent().at(-1)).toEndWith('INFO  [sync] kept for later');
    } finally {
      out.mockRestore();
    }
  });

  it("keeps a worker's lines with the main thread's", async () => {
    const worker = new Worker(new URL('./logger_worker.ts', import.meta.url));
    try {
      const deadline = Date.now() + 5000;
      const arrived = (): boolean =>
        logOutput.recent().some((line) => line.endsWith('[worker-test] logged from a worker'));
      while (!arrived() && Date.now() < deadline) await Bun.sleep(10);
      expect(arrived()).toBe(true);
    } finally {
      worker.terminate();
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

describe('LogOutput', () => {
  it('writes this run to the file and moves the last run aside', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bowerbird-log-'));
    const file = path.join(root, 'server.log');
    const output = new LogOutput();
    try {
      writeFileSync(file, 'last run\n');
      output.toFile(file);
      output.record('first');
      output.record('second\n  at trace');
      expect(readFileSync(file, 'utf8')).toBe('first\nsecond\n  at trace\n');
      expect(readFileSync(`${file}.1`, 'utf8')).toBe('last run\n');
      expect(output.recent()).toEqual(['first', 'second\n  at trace']);
    } finally {
      output.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps only the most recent lines in memory', () => {
    const output = new LogOutput();
    for (let i = 0; i < 2001; i++) output.record(`line ${i}`);
    expect(output.recent()).toHaveLength(2000);
    expect(output.recent()[0]).toBe('line 1');
  });
});
