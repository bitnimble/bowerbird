const LINES_KEPT = 2000;
const VALUE_CHARS_KEPT = 2000;
const LOG_PORT = 'bowerbirdLogPort';

type Level = 'INFO' | 'WARN' | 'ERROR';

const CONSOLE_METHODS = { INFO: 'info', WARN: 'warn', ERROR: 'error' } as const;

export class PageLog {
  private readonly lines: string[] = [];
  private toParent: MessagePort | null = null;
  /** A worker's lines from before its parent's port arrived. */
  private waiting: string[] | null = null;

  recent(): readonly string[] {
    return this.lines;
  }

  /**
   * Keeps every error nothing caught, which the browser already printed. In a worker, call before
   * setting `onmessage`: its lines go to the thread that {@link adopted} it, and on up to the page.
   */
  follow(thread: 'page' | 'worker' = 'page'): void {
    if (thread === 'worker') {
      this.waiting = [];
      self.addEventListener('message', (event) => {
        const port = logPortOf(event.data);
        if (port == null) return;
        event.stopImmediatePropagation();
        this.toParent = port;
        for (const line of this.waiting ?? []) port.postMessage(line);
        this.waiting = null;
      });
    }
    self.addEventListener('error', (event) =>
      this.record('ERROR', 'uncaught', [event.error ?? event.message]),
    );
    self.addEventListener('unhandledrejection', (event) =>
      this.record('ERROR', 'uncaught', [event.reason]),
    );
  }

  /** Takes a worker's lines into this thread's log; for every `new Worker`. */
  adopted<W extends Worker>(worker: W): W {
    const { port1, port2 } = new MessageChannel();
    port1.onmessage = (event: MessageEvent<string>) => this.keep(event.data);
    worker.postMessage({ [LOG_PORT]: port2 }, [port2]);
    return worker;
  }

  /** To the console and to the log the dialog shows. */
  write(level: Level, scope: string, args: unknown[]): void {
    this.record(level, scope, args);
    console[CONSOLE_METHODS[level]](`[${scope}]`, ...args);
  }

  record(level: Level, scope: string, args: unknown[]): void {
    const message = args.map(rendered).join(' ');
    this.keep(`${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${message}`);
  }

  private keep(line: string): void {
    if (this.toParent != null) {
      this.toParent.postMessage(line);
      return;
    }
    const held = this.waiting ?? this.lines;
    held.push(line);
    if (held.length > LINES_KEPT) held.shift();
  }
}

function logPortOf(data: unknown): MessagePort | null {
  if (typeof data !== 'object' || data == null || !(LOG_PORT in data)) return null;
  const port = data[LOG_PORT];
  return port instanceof MessagePort ? port : null;
}

/** The page's counterpart to the server's `Logger`: the console, and the logs dialog. */
export class Logger {
  constructor(
    private readonly scope: string,
    private readonly log: PageLog = pageLog,
  ) {}

  info(...args: unknown[]): void {
    this.log.write('INFO', this.scope, args);
  }

  warn(...args: unknown[]): void {
    this.log.write('WARN', this.scope, args);
  }

  error(...args: unknown[]): void {
    this.log.write('ERROR', this.scope, args);
  }
}

function rendered(value: unknown): string {
  const text = renderedWhole(value);
  return text.length > VALUE_CHARS_KEPT ? `${text.slice(0, VALUE_CHARS_KEPT)}…` : text;
}

function renderedWhole(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  if (ArrayBuffer.isView(value)) return `[${value.constructor.name}(${value.byteLength} bytes)]`;
  if (value instanceof ArrayBuffer) return `[ArrayBuffer(${value.byteLength} bytes)]`;
  if (typeof Node !== 'undefined' && value instanceof Node) return `[${value.nodeName}]`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export const pageLog = new PageLog();
