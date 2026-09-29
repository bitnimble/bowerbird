import type { Activity, ActivityKind } from '../../schemas/activity';

export class LibraryActivity {
  private readonly work = new Map<string | null, Map<ActivityKind, Map<string, number>>>();

  begin(libraryId: string | null, kind: ActivityKind, subject: string = kind): () => void {
    const library = this.work.get(libraryId) ?? new Map<ActivityKind, Map<string, number>>();
    const subjects = library.get(kind) ?? new Map<string, number>();
    subjects.set(subject, (subjects.get(subject) ?? 0) + 1);
    library.set(kind, subjects);
    this.work.set(libraryId, library);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const remaining = (subjects.get(subject) ?? 1) - 1;
      if (remaining > 0) subjects.set(subject, remaining);
      else subjects.delete(subject);
      if (subjects.size === 0) library.delete(kind);
      if (library.size === 0) this.work.delete(libraryId);
    };
  }

  async track<T>(
    libraryId: string | null,
    kind: ActivityKind,
    subject: string,
    run: () => T | Promise<T>,
  ): Promise<T> {
    const finish = this.begin(libraryId, kind, subject);
    try {
      return await run();
    } finally {
      finish();
    }
  }

  subjects(libraryId: string | null, kind: ActivityKind): ReadonlySet<string> {
    return new Set(this.work.get(libraryId)?.get(kind)?.keys());
  }

  current(libraryId: string | null): Activity[] {
    return [...(this.work.get(libraryId) ?? [])].map(([kind, subjects]) => ({
      kind,
      count: subjects.size,
    }));
  }

  stream(
    libraryId: string | null,
    kind: ActivityKind,
    subject: string,
    stream: ReadableStream<Uint8Array>,
  ): ReadableStream<Uint8Array> {
    const finish = this.begin(libraryId, kind, subject);
    const reader = stream.getReader();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          finish();
          reader.releaseLock();
          controller.close();
        } catch (err) {
          finish();
          reader.releaseLock();
          controller.error(err);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
          reader.releaseLock();
        }
      },
    });
  }

  response(
    libraryId: string | null,
    kind: ActivityKind,
    subject: string,
    response: Response,
  ): Response {
    if (response.body == null) return response;
    return new Response(this.stream(libraryId, kind, subject, response.body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }
}
