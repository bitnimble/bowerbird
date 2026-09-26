import { Hono } from 'hono';
import { AppError } from '../../errors';
import {
  BackupRunResponseSchema,
  BackupStatusSchema,
  BackupStatusesSchema,
  FetchBackStatusSchema,
  RemoveBackupQuerySchema,
  SetBackupRequestSchema,
  SetLocalBudgetRequestSchema,
  type BackupStatus,
} from '../../schemas/backup';
import { IdSchema } from '../../schemas/common';
import { PathSegment, route } from '../../schemas/route';
import type { Mirror } from '../../services/backup/mirror';
import { takeAsLongAsItTakes } from '../long_requests';
import { respond } from '../respond';

// Backing a library's originals up to a folder (docs/replication.md §14). Mounted under
// /api/backup, beside the replication and blob routes, and like them only reachable on the
// trusted network (§11.1).

export class BackupApi {
  readonly routes: Hono;

  constructor(private readonly backups: Mirror) {
    const app = new Hono();

    app.get(route(), (c) => c.json(respond(BackupStatusesSchema, { backups: this.backups.list() })));

    app.get(route(PathSegment.param('libraryId')), (c) =>
      c.json(respond(BackupStatusSchema, this.status(c.req.param('libraryId')))),
    );

    app.put(route(), async (c) => {
      const body = SetBackupRequestSchema.parse(await c.req.json());
      return c.json(respond(BackupStatusSchema, await this.backups.setTarget(body.library_id, body.path, body.name)));
    });

    // Fetching every offloaded original back first is minutes, like a pass.
    app.delete(route(PathSegment.param('libraryId')), async (c) => {
      const { fetch_first } = RemoveBackupQuerySchema.parse(c.req.query());
      takeAsLongAsItTakes(c);
      await this.backups.removeTarget(this.libraryId(c.req.param('libraryId')), fetch_first != null);
      return c.body(null, 204);
    });

    app.get(route(PathSegment.param('libraryId'), PathSegment.fetch()), (c) =>
      c.json(
        respond(FetchBackStatusSchema, {
          progress: this.backups.fetchBackProgress(this.libraryId(c.req.param('libraryId'))),
        }),
      ),
    );

    app.put(route(PathSegment.param('libraryId'), PathSegment.budget()), async (c) => {
      const libraryId = this.libraryId(c.req.param('libraryId'));
      const body = SetLocalBudgetRequestSchema.parse(await c.req.json());
      this.backups.setBudget(libraryId, body.local_budget_bytes);
      return c.json(respond(BackupStatusSchema, this.status(libraryId)));
    });

    // A pass copies whatever the backup is owed and then culls, so it is minutes on a library
    // somebody has just pointed at an empty drive.
    app.post(route(PathSegment.param('libraryId'), PathSegment.run()), async (c) => {
      takeAsLongAsItTakes(c);
      return c.json(respond(BackupRunResponseSchema, await this.backups.run(this.libraryId(c.req.param('libraryId')))));
    });

    this.routes = app;
  }

  private status(libraryId: string | undefined): BackupStatus {
    const status = this.backups.status(this.libraryId(libraryId));
    if (status == null) throw new AppError('NOT_FOUND', `library ${libraryId} has no backup folder`);
    return status;
  }

  private libraryId(value: string | undefined): string {
    return IdSchema.parse(value);
  }
}
