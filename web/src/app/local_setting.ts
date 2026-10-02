import { z } from 'zod';
import { readDeviceFile, shellInvoke, writeDeviceFile, type Invoke } from '../api/transport';
import { Logger } from '../features/logs/page_log';

const log = new Logger('storage');

/** Whole files this device keeps, too large to hold as preferences. */
export interface DeviceFiles {
  load(name: string): Promise<string | null>;
  save(name: string, contents: string): Promise<void>;
}

/** What this device keeps for itself: preferences read synchronously, and whole files. */
export interface DeviceStorage extends DeviceFiles {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

/**
 * The browser's own storage. Private browsing and a full quota both throw on write and on read,
 * and losing a preference is never worth taking the page down with it.
 */
class BrowserStorage implements DeviceStorage {
  read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  write(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {}
  }

  async load(name: string): Promise<string | null> {
    const kept = await (await this.cache()).match(this.request(name));
    return kept == null ? null : kept.text();
  }

  async save(name: string, contents: string): Promise<void> {
    await (await this.cache()).put(this.request(name), new Response(contents));
  }

  private cache(): Promise<Cache> {
    return caches.open('bowerbird-device');
  }

  private request(name: string): Request {
    return new Request(new URL(`/device/${name}.json`, self.location.origin));
  }
}

const PREFERENCES = 'preferences';
const PreferencesSchema = z.record(z.string(), z.string());

/** The app's data folder, through its shell: the page's origin changes every launch there. */
export class ShellStorage implements DeviceStorage {
  /** Saves in the order they were asked for, so an older write cannot land over a newer one. */
  private saved: Promise<unknown> = Promise.resolve();
  /** A drag writes on every move, so preferences changed while one save runs go in the next. */
  private flushed: Promise<void> | null = null;
  private dirty = false;

  private constructor(
    private readonly invoke: Invoke,
    private readonly preferences: Map<string, string>,
    /** False when the file could not be read: writing would replace what it holds with this session's. */
    private readonly keeps: boolean,
  ) {}

  static async open(invoke: Invoke): Promise<ShellStorage> {
    let text: string | null;
    try {
      text = await readDeviceFile(invoke, PREFERENCES);
    } catch (error) {
      log.warn('could not read this device’s preferences; keeping changes for this session', error);
      return new ShellStorage(invoke, new Map(), false);
    }
    const parsed = PreferencesSchema.safeParse(text == null ? {} : safeJson(text));
    return new ShellStorage(
      invoke,
      new Map(Object.entries(parsed.success ? parsed.data : {})),
      true,
    );
  }

  read(key: string): string | null {
    return this.preferences.get(key) ?? null;
  }

  write(key: string, value: string): void {
    this.preferences.set(key, value);
    if (!this.keeps) return;
    this.dirty = true;
    void this.flush();
  }

  /** Resolves once every preference written so far is saved. */
  flush(): Promise<void> {
    this.flushed ??= this.drain().finally(() => {
      this.flushed = null;
      if (this.dirty) void this.flush();
    });
    return this.flushed;
  }

  private async drain(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      await this.save(PREFERENCES, JSON.stringify(Object.fromEntries(this.preferences))).catch(
        (error: unknown) => log.warn('could not save this device’s preferences', error),
      );
    }
  }

  load(name: string): Promise<string | null> {
    return readDeviceFile(this.invoke, name);
  }

  save(name: string, contents: string): Promise<void> {
    const saving = this.saved.then(() => writeDeviceFile(this.invoke, name, contents));
    this.saved = saving.catch(() => undefined);
    return saving;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

let opened: DeviceStorage = new BrowserStorage();

export function deviceStorage(): DeviceStorage {
  return opened;
}

/** Before the first render, since preferences are read as the page's state is built. */
export async function openDeviceStorage(): Promise<void> {
  const invoke = shellInvoke();
  if (invoke != null) opened = await ShellStorage.open(invoke);
}

export function readSetting(key: string): string | null {
  return opened.read(key);
}

export function writeSetting(key: string, value: string): void {
  opened.write(key, value);
}

const FileAskSchema = z.discriminatedUnion('op', [
  z.object({ id: z.number(), op: z.literal('load'), name: z.string() }),
  z.object({ id: z.number(), op: z.literal('save'), name: z.string(), contents: z.string() }),
]);
const FileAnswerSchema = z.object({
  id: z.number(),
  contents: z.string().nullable(),
  error: z.string().nullable(),
});

/** Answers a worker's {@link PortedFiles}, which has no shell of its own to ask. */
export function serveFiles(port: MessagePort, files: () => DeviceFiles = deviceStorage): void {
  port.onmessage = async (event: MessageEvent<unknown>) => {
    const parsed = FileAskSchema.safeParse(event.data);
    if (!parsed.success) {
      log.warn('a worker asked for a device file in a shape this page cannot read', parsed.error);
      return;
    }
    const ask = parsed.data;
    try {
      let contents: string | null = null;
      if (ask.op === 'load') contents = await files().load(ask.name);
      else await files().save(ask.name, ask.contents);
      port.postMessage(FileAnswerSchema.parse({ id: ask.id, contents, error: null }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      port.postMessage(FileAnswerSchema.parse({ id: ask.id, contents: null, error: message }));
    }
  };
}

/** This device's files, from a worker, through the page that {@link serveFiles}. */
export class PortedFiles implements DeviceFiles {
  private readonly waiting = new Map<
    number,
    { resolve: (contents: string | null) => void; reject: (error: Error) => void }
  >();
  private asked = 0;
  private readonly port: Promise<MessagePort>;

  /** `port` may arrive after the first ask, which waits for it. */
  constructor(port: Promise<MessagePort>) {
    this.port = port.then((opened) => {
      opened.onmessage = this.answered;
      return opened;
    });
  }

  load(name: string): Promise<string | null> {
    return this.ask({ id: ++this.asked, op: 'load', name });
  }

  async save(name: string, contents: string): Promise<void> {
    await this.ask({ id: ++this.asked, op: 'save', name, contents });
  }

  private async ask(message: z.input<typeof FileAskSchema>): Promise<string | null> {
    const port = await this.port;
    return new Promise((resolve, reject) => {
      this.waiting.set(message.id, { resolve, reject });
      port.postMessage(message);
    });
  }

  private readonly answered = (event: MessageEvent<unknown>): void => {
    const answer = FileAnswerSchema.parse(event.data);
    const waiter = this.waiting.get(answer.id);
    this.waiting.delete(answer.id);
    if (answer.error == null) waiter?.resolve(answer.contents);
    else waiter?.reject(new Error(answer.error));
  };
}
