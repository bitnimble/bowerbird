import { expect, spyOn, test } from 'bun:test';
import { appLog } from '../app_log';
import { Logger, PageLog } from '../page_log';

test('renders what the page logged as the server does, errors with their stack', () => {
  const log = new PageLog();
  log.record('WARN', 'stage', ['decode slow', { ms: 40 }]);
  log.record('ERROR', 'stage', [new Error('lost the device')]);
  const [warn, error] = log.recent();
  expect(warn).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z WARN  \[stage\] decode slow \{"ms":40\}$/);
  expect(error).toContain('ERROR [stage] Error: lost the device\n');
});

test('names bulky values by size instead of spelling them out', () => {
  const log = new PageLog();
  log.record('INFO', 'stage', [new Float32Array(4), 'x'.repeat(5000)]);
  const [line] = log.recent();
  expect(line).toContain('[stage] [Float32Array(16 bytes)] ');
  expect(line).toEndWith(`${'x'.repeat(2000)}…`);
});

test('a Logger writes to the console and keeps the line', () => {
  const warn = spyOn(console, 'warn').mockImplementation(() => {});
  const log = new PageLog();
  try {
    new Logger('render', log).warn('fell back to the server', 404);
    expect(warn).toHaveBeenCalledWith('[render]', 'fell back to the server', 404);
  } finally {
    warn.mockRestore();
  }
  expect(log.recent()).toHaveLength(1);
  expect(log.recent()[0]).toEndWith('WARN  [render] fell back to the server 404');
});

test("a worker's lines reach the log of the thread that adopted it", async () => {
  const log = new PageLog();
  const worker = log.adopted(new Worker(new URL('./page_log_worker.ts', import.meta.url)));
  try {
    const arrived = (): boolean =>
      log.recent().some((line) => line.endsWith('INFO  [worker] logged before the port arrived'));
    const deadline = Date.now() + 5000;
    while (!arrived() && Date.now() < deadline) await Bun.sleep(10);
    expect(arrived()).toBe(true);
  } finally {
    worker.terminate();
  }
});

test('keeps only the most recent lines', () => {
  const log = new PageLog();
  for (let i = 0; i < 2001; i++) log.record('INFO', 'stage', [`line ${i}`]);
  expect(log.recent()).toHaveLength(2000);
  expect(log.recent()[0]).toEndWith('line 1');
});

test('outside the app, the app log is the page alone', async () => {
  const log = new PageLog();
  log.record('INFO', 'stage', ['opened']);
  expect(await appLog(log)).toEqual([...log.recent()]);
});
