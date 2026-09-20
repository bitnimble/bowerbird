import LibsqlDatabase from 'libsql';

// The catalogue's connection to libSQL.
//
// Everything libSQL does that the thirteen hundred statements above it should not have to know
// about is handled here and nowhere else: foreign keys enforced on a fresh connection, a statement
// cache, transactions that nest, a single row that answers `undefined` and carries a timing field,
// and a BLOB whose type depends on whether one row was read or many.
//
// Composed rather than subclassed, so the surface is exactly what the catalogue uses.

/** What a statement may be bound to, which is what SQLite itself stores. */
export type Bindable = string | number | bigint | boolean | null | undefined | Uint8Array;

/**
 * Every way this codebase binds a statement: a spread, or one array of values. Positional only.
 *
 * Do not add named bindings. Telling a lone `{ … }` from a lone value means asking its `typeof`,
 * and `null` and a `Uint8Array` both answer `'object'` - which is how a single BLOB bound to a
 * single placeholder reached libSQL as a map of names and panicked it, taking the process down.
 * A value needed twice in an upsert is what `excluded.` is for.
 */
export type Params = Bindable[] | [Bindable[]];

export interface Statement {
  run(...params: Params): { changes: number; lastInsertRowid: number | bigint };
  get(...params: Params): unknown;
  all(...params: Params): unknown[];
}

type TransactionBody = (...params: never[]) => unknown;

/** A transaction, and the one mode anything asks for by name. */
export interface Transaction<F extends TransactionBody> {
  (...params: Parameters<F>): ReturnType<F>;
  immediate(...params: Parameters<F>): ReturnType<F>;
}

/**
 * How the catalogue is opened.
 *
 * `create` asks for the file to be made if it is not there, which libSQL does unless told
 * otherwise - so it is accepted and ignored rather than made a caller's problem.
 */
export interface OpenOptions {
  readonly?: boolean;
  create?: boolean;
}

/**
 * Bindings as libSQL wants them: one argument, always an array, always bound by position.
 *
 * One argument rather than a spread, because libSQL decides what it was handed by looking at the
 * arguments it received - a *single* argument whose `typeof` is `'object'` is read as a map of
 * names, and `null` and a `Uint8Array` both answer to that. Spreading a one-element array therefore
 * sent a lone BLOB in as if it were named, which panicked the binding and took the process with it.
 * An array is never ambiguous: whatever is in it binds by position.
 */
function bindings(params: Params): Bindable[] {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params as Bindable[];
}

/**
 * One row, as the same row however it was read.
 *
 * Two things differ between `get` and `all` and both would make the same row compare unequal to
 * itself, which assertions and the replication merge both do:
 *
 * - `get` hands back libSQL's `_metadata` timing field alongside the columns; `all` does not.
 * - A BLOB arrives as a `Buffer` from `get` and a bare `ArrayBuffer` from `all`. An `ArrayBuffer`
 *   has no `length`, so a caller measuring one reads `undefined` rather than throwing - which is
 *   how stacking stopped: `descriptorsOf` keeps a descriptor whose length is the size this build
 *   writes, every descriptor failed that test, and detection found nothing, silently.
 *
 * Copied only where there is something to change, and the bytes are viewed rather than copied.
 */
function asRow(row: unknown, stripMetadata: boolean): unknown {
  if (row == null || typeof row !== 'object') return row;
  const columns = row as Record<string, unknown>;
  let copied: Record<string, unknown> | null =
    stripMetadata && '_metadata' in columns ? (({ _metadata, ...rest }) => rest)(columns) : null;
  for (const [key, value] of Object.entries(columns)) {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : Buffer.isBuffer(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : null;
    if (bytes == null) continue;
    copied ??= { ...columns };
    copied[key] = bytes;
  }
  return copied ?? row;
}

/** libSQL's own statement, as this file calls it: one argument, never a spread. */
interface Bound {
  run(bound: Bindable[]): { changes: number; lastInsertRowid: number | bigint };
  get(bound: Bindable[]): unknown;
  all(bound: Bindable[]): unknown[];
}

class Prepared implements Statement {
  constructor(private readonly inner: Bound) {}

  run(...params: Params): { changes: number; lastInsertRowid: number | bigint } {
    return this.inner.run(bindings(params));
  }

  get(...params: Params): unknown {
    // `null` rather than libSQL's `undefined` for a query that matched nothing: the row types are
    // written `T | null` and the assertions over them say `toBeNull`.
    const row = this.inner.get(bindings(params));
    return row === undefined ? null : asRow(row, true);
  }

  all(...params: Params): unknown[] {
    return this.inner.all(bindings(params)).map((row) => asRow(row, false));
  }
}

export class Database {
  private readonly inner: InstanceType<typeof LibsqlDatabase>;
  /**
   * Prepared statements, kept by their text.
   *
   * Load-bearing, not an optimisation: libSQL never frees a prepared statement. Its binding exposes
   * no `finalize` and `close()` does not release them either, so a process keeps about 5KB for every
   * distinct statement it has ever prepared. The hot paths prepare the same text per row they
   * return - the listing does - so preparing afresh would leak for the life of the server.
   *
   * libsql-js#228, open against 0.5.29; libsql-js#214 would fix it and has not been merged. It is
   * the same defect as the lock `close()` leaves behind, so both go together or neither does.
   */
  private readonly prepared = new Map<string, Statement>();
  private savepoints = 0;
  private readonly readonly: boolean;

  constructor(path: string, options: OpenOptions = {}) {
    this.readonly = options.readonly === true;
    this.inner = new LibsqlDatabase(path, { readonly: options.readonly });
    // libSQL enforces foreign keys on a fresh connection where SQLite's own default is not to.
    // DESIGN §4 says enforcement is a decision each connection makes and `createDatabase` is where
    // it is made, so every connection starts at the documented default rather than the engine's.
    if (options.readonly !== true) this.inner.exec('PRAGMA foreign_keys = OFF');
  }

  get inTransaction(): boolean {
    return this.inner.inTransaction;
  }

  query(sql: string): Statement {
    const known = this.prepared.get(sql);
    if (known != null) return known;
    const made = new Prepared(this.inner.prepare(sql) as unknown as Bound);
    this.prepared.set(sql, made);
    return made;
  }

  /** One statement, prepared and run. */
  run(sql: string, ...params: Params): { changes: number; lastInsertRowid: number | bigint } {
    return this.query(sql).run(...params);
  }

  exec(sql: string): void {
    this.inner.exec(sql);
  }

  /**
   * A transaction that can sit inside another, which is what the callers assume: a sync's outer
   * transaction calls repository methods that open their own, and the merge engine does the same
   * one layer down.
   *
   * Savepoints, because libSQL's own wrapper always issues `BEGIN` and SQLite refuses a second one.
   */
  transaction<F extends TransactionBody>(fn: F): Transaction<F> {
    const wrap =
      (mode: string) =>
      (...params: Parameters<F>): ReturnType<F> => {
        if (this.inTransaction) {
          const point = `bowerbird_sp_${this.savepoints++}`;
          this.exec(`SAVEPOINT ${point}`);
          try {
            const result = fn(...params) as ReturnType<F>;
            this.exec(`RELEASE ${point}`);
            return result;
          } catch (err) {
            this.exec(`ROLLBACK TO ${point}`);
            this.exec(`RELEASE ${point}`);
            throw err;
          }
        }
        this.exec(mode === '' ? 'BEGIN' : `BEGIN ${mode}`);
        try {
          const result = fn(...params) as ReturnType<F>;
          this.exec('COMMIT');
          return result;
        } catch (err) {
          this.exec('ROLLBACK');
          throw err;
        }
      };

    return Object.assign(wrap(''), { immediate: wrap('IMMEDIATE') });
  }

  close(): void {
    this.prepared.clear();
    this.checkpointOut();
    this.inner.close();
  }

  /**
   * Leaves the catalogue as its own file, in rollback mode, as SQLite's own last close does.
   *
   * libSQL leaves `-wal` and `-shm` behind holding every page since the last checkpoint, so a
   * cleanly closed catalogue is *not* the catalogue on its own: move the `.db` without its sidecars
   * and it does not merely lose rows, it will not open. Everything treating DB_PATH as the thing -
   * the restore's renames, a copy onto another volume - is built on it being self-contained.
   *
   * `journal_mode = DELETE` rather than `wal_checkpoint(TRUNCATE)`, which folds the pages in and
   * stops there. A catalogue left in WAL mode is refused an exclusive lock by every *later* process,
   * not merely by this one - which is how `bun run restore` came to report a catalogue as open in
   * another process when the server that wrote it had long exited. Rollback mode is also what
   * `VACUUM INTO` writes and what `refuseAMismatchedWal` is built around.
   *
   * Underneath is libsql-js#228: a connection that has prepared anything holds its read lock for the
   * life of the process, and neither a GC nor waiting nor `Statement.interrupt` shifts it. Leaving
   * rollback mode is the one thing that does. It needs the database to itself, so a close racing
   * another process's work loses the switch and leaves WAL mode behind - `sync_lock_lease` is where
   * that shows, and it is the price of the restore working at all.
   */
  private checkpointOut(): void {
    if (this.readonly) return;
    try {
      this.inner.exec('PRAGMA journal_mode = DELETE');
    } catch {
      // A connection already broken, or one another still holds: closing is still the right move,
      // and refusing to close over it would strand the handle instead.
    }
  }
}
