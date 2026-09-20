import { Hono } from 'hono';
import { PathSegment, route } from '../../schemas/route';
import { UpdateStatusSchema } from '../../schemas/updates';
import { respond } from '../respond';
import type { UpdateService } from '../../services/updates/update_service';

// No service layer beyond the one below: what a release is, and what applying one
// means, is all `UpdateService`, and this is three routes over it.
export class UpdatesApi {
  readonly routes: Hono;

  constructor(private readonly updates: UpdateService) {
    const app = new Hono();

    // The cached answer, refreshed if it has gone stale. What the page asks on launch
    // and on its hourly tick, so the common case is no call to GitHub at all.
    app.get(route(), async (c) => c.json(respond(UpdateStatusSchema, await this.updates.check())));

    // What the button in Settings asks: skip the cache and go and look.
    app.post(route(PathSegment.check()), async (c) => c.json(respond(UpdateStatusSchema, await this.updates.check(true))));

    // Answered before the process exits, which is why the status is read first: the
    // reply itself is the last thing this server does on the old version.
    app.post(route(PathSegment.apply()), async (c) => {
      await this.updates.apply();
      return c.json(respond(UpdateStatusSchema, this.updates.status()), 202);
    });

    this.routes = app;
  }
}
