import { readdir, readFile, writeFile } from 'node:fs/promises';
import { Logger } from '../logger';

const log = new Logger('shell-resources');

const SAMPLE_EVERY_MS = 5_000;
const SAMPLES_KEPT = 24;
const KINDS_SHOWN = 6;

/**
 * Samples the Android shell's threads and memory mappings by name, for a process that grows until
 * it aborts. The last samples are kept in `file`, since the abort takes this server and its logs
 * with it, and logged by the next run.
 */
export class ShellResources {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly samples: string[] = [];

  constructor(
    private readonly file: string,
    private readonly pid: number = process.ppid,
  ) {}

  async start(): Promise<void> {
    if (this.timer != null) return;
    const previous = await readFile(this.file, 'utf8').catch(() => '');
    for (const line of previous.split('\n').filter((line) => line !== ''))
      log.info('the previous run', { shell: line });
    this.timer = setInterval(() => void this.sample(), SAMPLE_EVERY_MS);
    this.timer.unref?.();
    await this.sample();
  }

  async sample(): Promise<void> {
    let line: string;
    try {
      line = await this.read();
    } catch (err) {
      log.debug('could not read the shell process', { pid: this.pid, err });
      return;
    }
    log.debug('shell process', { shell: line });
    this.samples.push(`${new Date().toISOString()} ${line}`);
    if (this.samples.length > SAMPLES_KEPT) this.samples.shift();
    await writeFile(this.file, this.samples.join('\n')).catch(() => {});
  }

  private async read(): Promise<string> {
    const proc = `/proc/${this.pid}`;
    const status = await readFile(`${proc}/status`, 'utf8');
    const tids = await readdir(`${proc}/task`);
    const names = await Promise.all(
      tids.map((tid) => readFile(`${proc}/task/${tid}/comm`, 'utf8').catch(() => '?')),
    );
    const maps = (await readFile(`${proc}/maps`, 'utf8')).split('\n').filter((line) => line !== '');
    const rss = /^VmRSS:\s*(.+)$/m.exec(status)?.[1] ?? '?';
    const threadKinds = commonest(names.map((name) => name.trim().replace(/\d+/g, '#')));
    return `rss ${rss}; ${tids.length} threads (${threadKinds}); ${maps.length} maps (${commonest(maps.map(mappedName))})`;
  }
}

function mappedName(line: string): string {
  const name = line.split(/\s+/).slice(5).join(' ');
  return name === '' ? '[anon]' : name.replace(/\d+/g, '#');
}

function commonest(names: string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .slice(0, KINDS_SHOWN)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
}
